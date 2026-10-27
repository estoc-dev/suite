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
  json,
  jsonSchema,
  type Link,
  linkOf,
  readObject,
  type Schema,
  type Signature,
  type Signatures,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { hex } from "@scure/base";
import { readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
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

/** What a Service says apart from `at`: where the service is reached, and what it offers there. */
type Said = Omit<ServiceData, "at">;

/**
 * The Services that a service signs, as its store holds them as mine. The
 * latest by `at` says where the service is and what it offers there, and
 * the ids that they list are the ids it gave out.
 */
class OwnServices {
  readonly #signer: Signer;
  readonly #identity: IdentityObject;
  readonly #signatures: Signatures;
  readonly #schema: Schema<Json, ServiceData>;
  readonly #locations: Locations;
  readonly #store: Store;

  constructor(signer: Signer, signatures: Signatures, schema: Schema<Json, ServiceData>, store: Store) {
    this.#signer = signer;
    this.#identity = signatures.identities.encode(signer.identity);
    this.#signatures = signatures;
    this.#schema = schema;
    this.#locations = locations(signatures, schema);
    this.#store = store;
  }

  /** The links of the service's signatures over them, from the latest `at` back. */
  links(): Promise<Link<Signature>[]> {
    return servicesOf(this.#store, this.#locations, this.#identity.link);
  }

  /** Whether the Service that `link` names the service's signature over lists `id`. */
  async lists(link: Link<Signature>, id: string): Promise<boolean> {
    return (await this.#read(link)).offers.some(({ accept }) => accept === id);
  }

  /**
   * The service's signature over `offer` and its id, as the latest Service
   * that lists the offer lists them, or `undefined` when none does.
   */
  async offering(
    offer: Link<unknown>,
  ): Promise<{ readonly signature: Signature; readonly accept: string } | undefined> {
    for (const link of await this.links()) {
      for (const { offer: listed, accept } of (await this.#read(link)).offers) {
        const signature = await this.#signatures.read(listed.$link, this.#store);
        if (signature.object === offer) return { signature, accept };
      }
    }
    return undefined;
  }

  /**
   * Has the latest Service say `said`. When it says that already, it stays
   * the latest, and else the service signs a new one and writes it with
   * `blobs`, which are what the offers lead to.
   */
  async say(said: Said, clock: () => number, blobs: readonly Uint8Array[]): Promise<void> {
    const [link] = await this.links();
    const latest = link === undefined ? undefined : await this.#read(link);
    if (latest !== undefined && says(latest, said)) return;
    // The latest `at` says where the service is, so a clock set back does
    // not put the new Service behind the one before.
    const at = latest === undefined ? clock() : Math.max(clock(), latest.at + 1);
    const object = encodeObject(this.#schema, { ...said, at });
    const signature = await this.#signatures.sign(object, this.#signer);
    const schemas = [this.#schema.bytes, this.#signatures.schema.bytes, this.#signatures.identities.schema.bytes];
    await this.#store.write({ mine: [signature], blobs: [object.bytes, this.#identity.bytes, ...schemas, ...blobs] });
  }

  async #read(link: Link<Signature>): Promise<ServiceData> {
    const { object } = await this.#signatures.read(link, this.#store);
    return (await readObject(this.#store, object, this.#schema)).data;
  }
}

/** Whether `service` says `said`, whenever it was signed. */
function says({ at: _, ...service }: ServiceData, said: Said): boolean {
  return linkOf(json.encode(service)) === linkOf(json.encode(said));
}

/**
 * A mailbox service, as a handler of HTTP requests. `GET /` answers the
 * service's signed Service, and a `POST` to the id that it lists for the
 * offer of an account opens one for whoever signed the offer.
 */
class MailboxService {
  readonly #signer: Signer;
  readonly #offer: EncodedObject<Json, AccountOfferData>;
  readonly #services: OwnServices;
  readonly #authorizations: Authorizations;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #clock: () => number;

  constructor(
    signer: Signer,
    { offer, services }: { readonly offer: EncodedObject<Json, AccountOfferData>; readonly services: OwnServices },
    authorizations: Authorizations,
    acknowledgement: Schema<Json, AcknowledgementData>,
    { store, accounts, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "clock">>,
  ) {
    this.#signer = signer;
    this.#offer = offer;
    this.#services = services;
    this.#authorizations = authorizations;
    this.#acknowledgementSchema = acknowledgement;
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
    const [root, ...earlier] = await this.#services.links();
    if (root === undefined) throw new Error("the store holds no Service of the service's");
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(root, 200));
    const id = pathname.slice(1);
    if (!ID.test(id)) return answer(404);
    // A Service of the service's lists its offer of an account alone, so an
    // id that the latest lists takes acceptances of that offer.
    if (await this.#services.lists(root, id)) return answerTo(request, "POST", () => this.#open(request));
    for (const link of earlier) if (await this.#services.lists(link, id)) return answer(410);
    return answer(404);
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
 * Makes the service of `signer`'s identity at `origin`. Its store holds the
 * Services it signed before: the latest stays when the origin and the offer
 * are as it says, and else the service signs a new one, which keeps the
 * service's signature over the offer and its id from the latest Service
 * that lists them.
 */
export async function loadMailboxService(
  signer: Signer,
  { origin, validator, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const authorizations = await loadAuthorizations(validator);
  const { signatures } = authorizations;
  const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  const service: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, validator);
  const services = new OwnServices(signer, signatures, service, options.store);
  const offer = encodeObject(offerSchema, { identity: { $link: signatures.identities.encode(signer.identity).link } });

  const offered = await services.offering(offer.link);
  const signature = offered?.signature ?? (await signatures.sign(offer, signer));
  // Sixteen random bytes do not come out twice, so a new id is not checked
  // against those given out before.
  const accept = offered?.accept ?? hex.encode(crypto.getRandomValues(new Uint8Array(16)));
  const offers = [{ offer: { $link: signature.link }, accept }];
  await services.say({ origin, offers }, clock, [signature.bytes, offer.bytes, offerSchema.bytes]);
  return new MailboxService(signer, { offer, services }, authorizations, acknowledgement, { ...options, clock });
}
