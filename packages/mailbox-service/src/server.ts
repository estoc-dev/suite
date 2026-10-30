import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  type KeyObject,
  loadSignatures,
  type Signature,
  type Signatures,
  type Signer,
} from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchemaValidator,
  type Link,
  readObject,
  type Schema,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  formOf,
  ID,
  type ServiceData,
  serviceSchema,
} from "./schemas.ts";

// Anyone can post to a service, and an acceptance is a few small blobs: a
// signature and its signed identity.
const REQUEST_LIMIT = 64 * 1024;

type Schemas = {
  readonly service: Schema<Json, ServiceData>;
  readonly acknowledgement: Schema<Json, AcknowledgementData>;
};

/**
 * The accounts of a service, one for each root of an identity, as the link
 * of the service's signature over the acknowledgement that opened it.
 */
export interface Accounts {
  /** The acknowledgement of `root`'s account, or `undefined` when it has none. */
  get(root: Link<KeyObject>): Promise<Link<Signature> | undefined>;
  /**
   * Keeps `acknowledgement` as `root`'s unless it has an account already, in
   * one step, and resolves to whether it was kept.
   */
  add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean>;
}

/** Keeps accounts in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<KeyObject>, Link<Signature>>();

  async get(root: Link<KeyObject>): Promise<Link<Signature> | undefined> {
    return this.#accounts.get(root);
  }

  async add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean> {
    if (this.#accounts.has(root)) return false;
    this.#accounts.set(root, acknowledgement);
    return true;
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
   * Where the service writes what it signs as its own, with all it leads
   * to: its Services, which say what ids it gave out, and the
   * acknowledgements.
   */
  readonly store: Store;
  readonly accounts: Accounts;
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
  readonly #actor: Actor;
  readonly #offer: EncodedObject<Json, AccountOfferData>;
  readonly #locations: Locations;
  readonly #signatures: Signatures;
  readonly #schemas: Schemas;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #clock: () => number;

  constructor(
    actor: Actor,
    { offer, locations }: { readonly offer: EncodedObject<Json, AccountOfferData>; readonly locations: Locations },
    signatures: Signatures,
    schemas: Schemas,
    { store, accounts, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "clock">>,
  ) {
    this.#actor = actor;
    this.#offer = offer;
    this.#locations = locations;
    this.#signatures = signatures;
    this.#schemas = schemas;
    this.#store = store;
    this.#accounts = accounts;
    this.#clock = clock;
  }

  /**
   * Answers a request, from any origin, since no request carries
   * credentials, by the Services of the service's that the store holds now.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const [latest, ...earlier] = await servicesOf(this.#store, this.#locations, this.#offer.data.identity.$link);
    if (latest === undefined) throw new Error("the store holds no Service of the service's");
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(latest, 200));
    const id = pathname.slice(1);
    if (!ID.test(id)) return answer(404);
    if (id === this.#offer.link && (await this.#lists(latest, id))) {
      return answerTo(request, "POST", () => this.#open(request));
    }
    for (const link of earlier) if (await this.#lists(link, id)) return answer(410);
    return answer(404);
  }

  async #lists(link: Link<Signature>, id: string): Promise<boolean> {
    const { offers } = (await readService(link, this.#signatures, this.#store, this.#schemas.service)).data;
    return offers.some(({ accept }) => accept === id);
  }

  /**
   * Opens an account for the root of the identity whose signature over the
   * offer is posted, or answers with the acknowledgement that opened theirs.
   */
  async #open(request: Request): Promise<Response> {
    const zip = await readBody(request.body, REQUEST_LIMIT);
    if (zip === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const offer = this.#offer;
    let accepted: Bundle;
    let acceptance: Signature;
    try {
      accepted = await unpackBundle(zip);
      acceptance = await this.#signatures.read(accepted.link, accepted);
      if (acceptance.object !== offer.link) throw new Error(`the acceptance signs ${acceptance.object}, not the offer`);
      if (acceptance.signedIdentity.identity.root.link === offer.data.identity.$link)
        throw new Error("a service opens no account for itself");
    } catch (error) {
      return answer(400, error instanceof Error ? error.message : String(error));
    }
    const { signedIdentity } = acceptance;
    const root = signedIdentity.identity.root.link;

    const kept = await this.#accounts.get(root);
    if (kept !== undefined) return this.#answerWith(kept, 200);
    const acknowledgement = encodeObject(this.#schemas.acknowledgement, { accepted: { $link: accepted.link }, at });
    const signature = await this.#actor.sign(acknowledgement);
    // Reading the acceptance takes neither the schemas its signed identity
    // leads to nor the interfaces they name, so the bundle need not hold
    // them, and the store takes a blob in only with all it leads to.
    const blobs = [acknowledgement.bytes, this.#schemas.acknowledgement.bytes, ...signedIdentity.blobs];
    await this.#store.write({ mine: [signature], blobs: [...blobs, ...accepted.blobs()] });
    if (await this.#accounts.add(root, signature.link)) return this.#answerWith(signature.link, 201);
    const opened = await this.#accounts.get(root);
    if (opened === undefined) throw new Error(`the accounts refused to add ${root} and hold no account for it`);
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
 * Makes the service of `signer`'s identity at `origin`. The store holds the
 * Services it signed before, the latest of which says where it was and what
 * it offered there. When the service says the same now, that Service stays
 * the latest, and else the service signs a new one. Either way the offer is
 * listed under its link, with the service's signature over it from the
 * latest Service that lists it. The service signs as the signed identity
 * of its latest Service, and publishes its identity only when the store
 * holds no Service of it.
 */
export async function loadMailboxService(
  signer: Signer,
  { origin, validator, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store } = options;
  const signatures = await loadSignatures(validator);
  const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const schemas: Schemas = {
    service: await encodeSchema(serviceSchema, validator),
    acknowledgement: await encodeSchema(acknowledgementSchema, validator),
  };
  const root = signatures.identities.keys.encode(signer.key);
  const offer = encodeObject(offerSchema, { identity: { $link: root.link } });
  const index = locations(signatures, schemas.service);

  const signed = await Promise.all(
    (await servicesOf(store, index, root.link)).map((link) => signatures.read(link, store)),
  );
  const [latest] = signed;
  const actor = signatures.actor(signer, latest?.signedIdentity ?? (await signatures.identities.publish(signer)));
  const services = await Promise.all(signed.map(({ object }) => readObject(store, object, schemas.service)));
  const [previous] = services;
  const signature = (await signedIn(services, offer.link, signatures, store)) ?? (await actor.sign(offer));
  const next: ServiceData = {
    origin,
    // The latest `at` says where the service is, so a clock set back does
    // not put the new Service behind the one before.
    at: previous === undefined ? clock() : Math.max(clock(), previous.data.at + 1),
    offers: [{ offer: { $link: signature.link }, accept: offer.link }],
  };
  if (previous === undefined || formOf(previous.data) !== formOf(next)) {
    const object = encodeObject(schemas.service, next);
    const blobs = [
      object.bytes,
      schemas.service.bytes,
      signature.bytes,
      offer.bytes,
      offerSchema.bytes,
      signatures.schema.bytes,
      ...actor.signedIdentity.blobs,
    ];
    await store.write({ mine: [await actor.sign(object)], blobs });
  }
  return new MailboxService(actor, { offer, locations: index }, signatures, schemas, { ...options, clock });
}

async function readService(
  link: Link<Signature>,
  signatures: Signatures,
  store: Store,
  service: Schema<Json, ServiceData>,
): Promise<EncodedObject<Json, ServiceData>> {
  return readObject(store, (await signatures.read(link, store)).object, service);
}

/** The service's signature over `offer`, as the first of `services` that lists the offer lists it, when one does. */
async function signedIn(
  services: readonly EncodedObject<Json, ServiceData>[],
  offer: Link<unknown>,
  signatures: Signatures,
  store: Store,
): Promise<Signature | undefined> {
  for (const { data } of services) {
    for (const { offer: listed } of data.offers) {
      const signature = await signatures.read(listed.$link, store);
      if (signature.object === offer) return signature;
    }
  }
  return undefined;
}
