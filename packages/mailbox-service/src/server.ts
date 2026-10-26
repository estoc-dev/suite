import {
  type Authorizations,
  authorizationSchema,
  loadAuthorizations,
  proxySchema,
  type Signed,
} from "@estoc/authorization";
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
  type Schema,
  type Signature,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { readBody, ZIP } from "./http.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
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
   * Where the service writes its offer and the acknowledgements it signs as
   * its own, with all they lead to.
   */
  readonly store: Store;
  readonly accounts: Accounts;
  /** The validator that the schemas are compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * A mailbox service, as a handler of HTTP requests. `GET /offer` answers the
 * service's signed offer, and `POST /` opens an account for whoever signed
 * it.
 */
class MailboxService {
  readonly #signer: Signer;
  readonly #offer: Signed<EncodedObject<Json, AccountOfferData>>;
  readonly #authorizations: Authorizations;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #clock: () => number;

  constructor(
    signer: Signer,
    offer: Signed<EncodedObject<Json, AccountOfferData>>,
    authorizations: Authorizations,
    acknowledgement: Schema<Json, AcknowledgementData>,
    { store, accounts, clock = Date.now }: Omit<ServiceOptions, "validator">,
  ) {
    this.#signer = signer;
    this.#offer = offer;
    this.#authorizations = authorizations;
    this.#acknowledgementSchema = acknowledgement;
    this.#store = store;
    this.#accounts = accounts;
    this.#clock = clock;
  }

  /** Answers a request, from any origin, since no request carries credentials. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/offer") return answerTo(request, "GET", () => this.#answerWith(this.#offer.signature.link, 200));
    if (pathname === "/") return answerTo(request, "POST", () => this.#open(request));
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
    const offer = this.#offer.object;
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
    return this.#answerWith((await this.#accounts.get(identity))!, 200);
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
 * Makes the service of `signer`'s identity. It signs its offer once, here,
 * and writes the signature to the store with the offer.
 */
export async function loadMailboxService(
  signer: Signer,
  { validator, ...options }: ServiceOptions,
): Promise<MailboxService> {
  const authorizations = await loadAuthorizations(validator);
  const { signatures } = authorizations;
  const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  const identity = signatures.identities.encode(signer.identity);
  const object = encodeObject(offerSchema, { identity: { $link: identity.link } });
  const signature = await signatures.sign(object, signer);
  const blobs = [
    object.bytes,
    offerSchema.bytes,
    identity.bytes,
    signatures.schema.bytes,
    signatures.identities.schema.bytes,
  ];
  await options.store.write({ mine: [signature], blobs });
  return new MailboxService(signer, { object, signature }, authorizations, acknowledgement, options);
}
