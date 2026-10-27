import { type Authorizations, authorizationSchema, loadAuthorizations, proxySchema } from "@estoc/authorization";
import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import type { Signer } from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type IdentityObject,
  type Json,
  type JsonSchemaValidator,
  jsonSchema,
  type Link,
  readObject,
  type Schema,
  type Signature,
  type Signatures,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { hex } from "@scure/base";
import { readBody, ZIP } from "./http.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  ID,
  type ServiceData,
  serviceSchema,
} from "./schemas.ts";

// Anyone can post to a service, and an acceptance is a few small blobs: a
// signature and an identity, or a proxy and its chain.
const REQUEST_LIMIT = 64 * 1024;

// An acceptance through a proxy leads to these schemas, which a client need
// not send, since the service has them.
const CHAIN_SCHEMAS = [proxySchema, authorizationSchema].map((schema) => jsonSchema.encode(schema));

/**
 * The accounts of a service, one for each identity, as the link of the
 * service's signature over the acknowledgement that opened it.
 */
export interface Accounts {
  /** The acknowledgement of `identity`'s account, or `undefined` when it has none. */
  get(identity: Link<IdentityObject>): Promise<Link<Signature> | undefined>;
  /**
   * Keeps `acknowledgement` as `identity`'s unless it has an account already,
   * in one step, and resolves to whether it was kept.
   */
  add(identity: Link<IdentityObject>, acknowledgement: Link<Signature>): Promise<boolean>;
}

/** Keeps accounts in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<IdentityObject>, Link<Signature>>();

  async get(identity: Link<IdentityObject>): Promise<Link<Signature> | undefined> {
    return this.#accounts.get(identity);
  }

  async add(identity: Link<IdentityObject>, acknowledgement: Link<Signature>): Promise<boolean> {
    if (this.#accounts.has(identity)) return false;
    this.#accounts.set(identity, acknowledgement);
    return true;
  }
}

/** What an id that a service gave out names: the offer whose acceptances it takes. */
export type Named = { readonly accepts: Link<unknown> };

/**
 * What a service gave out and answers for from then on: each id in the
 * addresses it signs, with what the id names, and the Service it answers
 * `GET /` with. An id names one thing for good: once the service no longer
 * makes the offer that an id names, it answers 410 there, and the id names
 * nothing else.
 */
export interface Registry {
  /** What `id` names, or `undefined` when the service did not give it out. */
  get(id: string): Promise<Named | undefined>;
  /**
   * Keeps `named` under `id` unless the id was given out already, in one
   * step, and resolves to whether it was kept.
   */
  add(id: string, named: Named): Promise<boolean>;
  /**
   * The link of the service's signature over the Service that it answers
   * `GET /` with, or `undefined` before it signs one.
   */
  root(): Promise<Link<Signature> | undefined>;
  /** Makes `link` the root, in place of the one before. */
  setRoot(link: Link<Signature>): Promise<void>;
}

/** Keeps a registry in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryRegistry implements Registry {
  readonly #named = new Map<string, Named>();
  #root: Link<Signature> | undefined;

  async get(id: string): Promise<Named | undefined> {
    return this.#named.get(id);
  }

  async add(id: string, named: Named): Promise<boolean> {
    if (this.#named.has(id)) return false;
    this.#named.set(id, named);
    return true;
  }

  async root(): Promise<Link<Signature> | undefined> {
    return this.#root;
  }

  async setRoot(link: Link<Signature>): Promise<void> {
    this.#root = link;
  }
}

export interface ServiceOptions {
  /**
   * The origin the service is reached at, such as `https://mail.example`,
   * which it signs into its Service. It is set here rather than read from a
   * request, whose host is the requester's to choose.
   */
  readonly origin: string;
  /**
   * Where the service writes its Service and the acknowledgements it signs
   * as its own, with all they lead to.
   */
  readonly store: Store;
  readonly accounts: Accounts;
  readonly registry: Registry;
  /** The validator that the schemas are compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * A mailbox service, as a handler of HTTP requests. `GET /` answers the
 * service's signed Service, and a `POST` to the id that it lists for the
 * offer of an account opens one for whoever signed the offer.
 */
class MailboxService {
  readonly #signer: Signer;
  readonly #root: Link<Signature>;
  readonly #offer: EncodedObject<Json, AccountOfferData>;
  readonly #authorizations: Authorizations;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #registry: Registry;
  readonly #clock: () => number;

  constructor(
    signer: Signer,
    { root, offer }: { readonly root: Link<Signature>; readonly offer: EncodedObject<Json, AccountOfferData> },
    authorizations: Authorizations,
    acknowledgement: Schema<Json, AcknowledgementData>,
    { store, accounts, registry, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "registry" | "clock">>,
  ) {
    this.#signer = signer;
    this.#root = root;
    this.#offer = offer;
    this.#authorizations = authorizations;
    this.#acknowledgementSchema = acknowledgement;
    this.#store = store;
    this.#accounts = accounts;
    this.#registry = registry;
    this.#clock = clock;
  }

  /** Answers a request, from any origin, since no request carries credentials. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(this.#root, 200));
    const id = pathname.slice(1);
    const named = ID.test(id) ? await this.#registry.get(id) : undefined;
    if (named === undefined) return answer(404);
    if (named.accepts !== this.#offer.link) return answer(410);
    return answerTo(request, "POST", () => this.#open(request));
  }

  /**
   * Opens an account for whoever the posted acceptance stands behind the
   * offer now, or answers with the acknowledgement that opened theirs.
   */
  async #open(request: Request): Promise<Response> {
    const zip = await readBody(request.body, REQUEST_LIMIT);
    if (zip === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const offer = this.#offer;
    let accepted: Bundle;
    let identity: Link<IdentityObject>;
    try {
      accepted = await unpackBundle(zip);
      const { principal } = await this.#authorizations.readStanding(offer.link, accepted.link, accepted, new Date(at));
      if (principal.link === offer.data.identity.$link) throw new Error("a service opens no account for itself");
      identity = principal.link;
    } catch (error) {
      return answer(400, error instanceof Error ? error.message : String(error));
    }

    const kept = await this.#accounts.get(identity);
    if (kept !== undefined) return this.#answerWith(kept, 200);
    const acknowledgement = encodeObject(this.#acknowledgementSchema, { accepted: { $link: accepted.link }, at });
    const signature = await this.#authorizations.signatures.sign(acknowledgement, this.#signer);
    const schemas = [this.#acknowledgementSchema.bytes, ...CHAIN_SCHEMAS];
    await this.#store.write({ mine: [signature], blobs: [acknowledgement.bytes, ...schemas, ...accepted.blobs()] });
    if (await this.#accounts.add(identity, signature.link)) return this.#answerWith(signature.link, 201);
    const opened = await this.#accounts.get(identity);
    if (opened === undefined) throw new Error(`the accounts refused to add ${identity} and hold no account for it`);
    return this.#answerWith(opened, 200);
  }

  /** Answers with the bundle of one of the service's signatures and all it leads to in the store. */
  async #answerWith(link: Link<Signature>, status: number): Promise<Response> {
    const closure = await this.#store.closure(link);
    const bytes = closure.get(link);
    if (bytes === undefined) throw new Error(`the store does not hold ${link}`);
    const blobs = [...closure].filter(([linked]) => linked !== link).map(([, blob]) => blob);
    return bundleAnswer(status, await packBundle({ bytes }, blobs));
  }
}

export type { MailboxService };

function answerTo(request: Request, method: string, handle: () => Promise<Response>): Promise<Response> | Response {
  // A browser asks before it posts a zip to another origin.
  if (request.method === "OPTIONS") {
    return answer(204, null, {
      "access-control-allow-methods": method,
      "access-control-allow-headers": "content-type",
    });
  }
  if (request.method !== method) return answer(405, null, { allow: method });
  return handle();
}

function answer(
  status: number,
  reason: string | null = null,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(reason, { status, headers: { "access-control-allow-origin": "*", ...headers } });
}

function bundleAnswer(status: number, zip: Uint8Array): Response {
  return new Response(zip, { status, headers: { "access-control-allow-origin": "*", "content-type": ZIP } });
}

/**
 * Makes the service of `signer`'s identity at `origin`. It signs its offer
 * and a Service that lists it, and writes the signature over the Service to
 * the store with all it leads to. Started again with the same registry and
 * store, it keeps the Service when the origin and the offer are as they
 * were, and else signs a new one that keeps the ids of the offers it still
 * makes.
 */
export async function loadMailboxService(
  signer: Signer,
  { origin, validator, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store, registry } = options;
  const authorizations = await loadAuthorizations(validator);
  const { signatures } = authorizations;
  const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  const service: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, validator);
  const identity = signatures.identities.encode(signer.identity);
  const offer = encodeObject(offerSchema, { identity: { $link: identity.link } });

  const previous = await previousService(registry, signatures, store, service);
  const kept = await offeredIn(previous?.object.data, offer.link, signatures, store);
  const signature = kept?.signature ?? (await signatures.sign(offer, signer));
  const accept = kept?.accept ?? (await giveOut(registry, { accepts: offer.link }));
  const offers = [{ offer: { $link: signature.link }, accept }];
  const unchanged =
    previous !== undefined &&
    encodeObject(service, { origin, at: previous.object.data.at, offers }).link === previous.object.link;
  let root: Link<Signature>;
  if (unchanged) {
    root = previous.root;
  } else {
    const object = encodeObject(service, { origin, at: clock(), offers });
    const signed = await signatures.sign(object, signer);
    const blobs = [
      object.bytes,
      service.bytes,
      signature.bytes,
      offer.bytes,
      offerSchema.bytes,
      identity.bytes,
      signatures.schema.bytes,
      signatures.identities.schema.bytes,
    ];
    await store.write({ mine: [signed], blobs });
    await registry.setRoot(signed.link);
    root = signed.link;
  }
  return new MailboxService(signer, { root, offer }, authorizations, acknowledgement, { ...options, clock });
}

/** The Service that the registry holds as the root, read from the store, when it holds one. */
async function previousService(
  registry: Registry,
  signatures: Signatures,
  store: Store,
  service: Schema<Json, ServiceData>,
): Promise<{ readonly root: Link<Signature>; readonly object: EncodedObject<Json, ServiceData> } | undefined> {
  const root = await registry.root();
  if (root === undefined) return undefined;
  return { root, object: await readObject(store, (await signatures.read(root, store)).object, service) };
}

/** The signature over `offer` and its id, as the Service `previous` lists them, when it lists them. */
async function offeredIn(
  previous: ServiceData | undefined,
  offer: Link<unknown>,
  signatures: Signatures,
  store: Store,
): Promise<{ readonly signature: Signature; readonly accept: string } | undefined> {
  for (const { offer: listed, accept } of previous?.offers ?? []) {
    const signature = await signatures.read(listed.$link, store);
    if (signature.object === offer) return { signature, accept };
  }
  return undefined;
}

async function giveOut(registry: Registry, named: Named): Promise<string> {
  const id = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
  if (!(await registry.add(id, named))) throw new Error(`the registry gave out ${id} already`);
  return id;
}
