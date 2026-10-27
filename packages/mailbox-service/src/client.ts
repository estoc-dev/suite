import { type Actor, type Authorizations, loadAuthorizations } from "@estoc/authorization";
import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  decodeObject,
  type EncodedObject,
  encodeSchema,
  type IdentityObject,
  type Json,
  type JsonSchemaValidator,
  json,
  type Link,
  type Reader,
  readObject,
  type Schema,
  type Signature,
  schemaOf,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  type ServiceData,
  serviceSchema,
} from "./schemas.ts";

// The answers hold an acceptance and a few blobs of the service's. The
// client chose the service, so this only bounds what it reads.
const ANSWER_LIMIT = 1024 * 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A redirect would take the request to another origin than the one the
// client chose, or the one the Service names.
const REQUEST = {
  redirect: "error",
  credentials: "omit",
  referrerPolicy: "no-referrer",
} as const satisfies RequestInit;

type Schemas = {
  readonly service: Schema<Json, ServiceData>;
  readonly offer: Schema<Json, AccountOfferData>;
  readonly acknowledgement: Schema<Json, AcknowledgementData>;
};

/** An identity's account at a service, written to the store. */
export interface Account {
  /** The identity whose account it is: the principal of the actor that accepted the offer. */
  readonly identity: IdentityObject;
  /** The service's identity, which signed the offer and the acknowledgement. */
  readonly service: IdentityObject;
  /**
   * When the service received the acceptance that opened the account, in
   * milliseconds since the Unix epoch by the service's clock.
   */
  readonly at: number;
  /** The link of the service's signature over the acknowledgement. */
  readonly link: Link<Signature>;
}

/** A service as one of its Services says: where its identity is reached, and what it offers there. */
export interface Service {
  /** The service's identity, which signed the Service and each offer it lists. */
  readonly identity: IdentityObject;
  /** The origin the service is reached at. */
  readonly origin: string;
  /** When the service signed the Service, in milliseconds since the Unix epoch by its clock. */
  readonly at: number;
  /** The link of the service's signature over the Service. */
  readonly link: Link<Signature>;
  /** The service's offer of an account, or `undefined` when the Service lists none. */
  readonly account: AccountOffer | undefined;
}

/** A service's offer of an account, taken at the id that the Service lists for it. */
export class AccountOffer {
  /** The service's identity, which the offer names and which signed it. */
  readonly service: IdentityObject;
  readonly link: Link<EncodedObject<Json, AccountOfferData>>;
  readonly #url: URL;
  readonly #store: Store;
  readonly #authorizations: Authorizations;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;

  constructor(
    { service, offer, url }: { readonly service: IdentityObject; readonly offer: Link<never>; readonly url: URL },
    store: Store,
    authorizations: Authorizations,
    acknowledgement: Schema<Json, AcknowledgementData>,
  ) {
    this.service = service;
    this.link = offer;
    this.#url = url;
    this.#store = store;
    this.#authorizations = authorizations;
    this.#acknowledgementSchema = acknowledgement;
  }

  /**
   * Opens an account for the actor's principal by accepting the offer: the
   * actor signs the offer, or a proxy for it. Writes the service's signature
   * over the acknowledgement to the store as mine, with all it leads to. An
   * identity that has an account there already gets the acknowledgement of
   * the acceptance that opened it, which may have come from another device.
   */
  async accept(actor: Actor): Promise<Account> {
    // The service holds the offer and the schemas, so they are left out.
    const acceptance = await actor.sign(this.link);
    const body = await packBundle(acceptance.signature, acceptance.blobs);
    const request = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body };
    const answer = await bundleIn(await fetch(this.#url, request), [200, 201]);
    const acknowledgement = await this.#authorizations.signatures.read(answer.link, answer);
    if (acknowledgement.identity.link !== this.service.link) {
      throw new Error("the acknowledgement is signed by another identity than the service's");
    }
    const { accepted, at } = (await readObject(answer, acknowledgement.object, this.#acknowledgementSchema)).data;
    // The acceptance that opened an account stood when the service received
    // it, though an authorization in its chain may have ended since.
    const { principal } = await this.#authorizations.readStanding(this.link, accepted.$link, answer, new Date(at));
    if (principal.link !== actor.principal.link)
      throw new Error("the acknowledgement is of another identity's account");
    await this.#store.write({ mine: [acknowledgement], blobs: answer.blobs() });
    return { identity: actor.principal, service: this.service, at, link: acknowledgement.link };
  }
}

/**
 * Mailbox services as a client reaches them, with a store that keeps the
 * Services it reaches and the accounts it opens.
 */
export class Services {
  readonly #store: Store;
  readonly #authorizations: Authorizations;
  readonly #schemas: Schemas;
  readonly #locations: Locations;

  constructor(store: Store, authorizations: Authorizations, schemas: Schemas) {
    this.#store = store;
    this.#authorizations = authorizations;
    this.#schemas = schemas;
    this.#locations = locations(authorizations.signatures, schemas.service);
  }

  /**
   * Gets the Service at `origin`, such as `https://mail.example`, and writes
   * the service's signature over it to the store as mine, with all it leads
   * to. What the origin answers over TLS is the service's, so the identity
   * that signed the Service is taken as the service's. A Service that names
   * another origin is refused.
   */
  async at(origin: string): Promise<Service> {
    checkOrigin(origin);
    const bundle = await bundleIn(await fetch(new URL("/", origin), REQUEST), [200]);
    const service = await this.#read(bundle.link, bundle);
    if (service.origin !== origin) throw new Error(`the Service at ${origin} names ${service.origin}`);
    await this.#store.write({ mine: [{ bytes: bundle.root }], blobs: bundle.blobs() });
    return service;
  }

  /**
   * The latest Service of `identity` that the store holds, read without
   * reaching the service, or `undefined` when the store holds none. A
   * Service gets there by `at`, on this device or on another whose store
   * this one syncs with.
   */
  async of(identity: Link<IdentityObject>): Promise<Service | undefined> {
    const [latest] = await servicesOf(this.#store, this.#locations, identity);
    return latest === undefined ? undefined : this.#read(latest, this.#store);
  }

  /**
   * Reads the Service that `link` names the service's signature over.
   * Refuses it when its origin is not one that a client reaches, when an
   * offer it lists is signed by another identity, or when its offer of an
   * account names another identity. Offers of schemas the client does not
   * read are passed over.
   */
  async #read(link: Link<Signature>, reader: Reader): Promise<Service> {
    const { signatures } = this.#authorizations;
    const { identity, object } = await signatures.read(link, reader);
    const { origin, at, offers } = (await readObject(reader, object, this.#schemas.service)).data;
    checkOrigin(origin);
    let account: AccountOffer | undefined;
    for (const { offer, accept } of offers) {
      const signature = await signatures.read(offer.$link, reader);
      if (signature.identity.link !== identity.link) {
        throw new Error(`the Service of ${identity.link} lists an offer signed by another identity`);
      }
      const bytes = await reader.get(signature.object);
      if (bytes === undefined) throw new Error(`no blob is given for ${signature.object}`);
      if (account !== undefined || schemaOf(bytes, json) !== this.#schemas.offer.link) continue;
      if (decodeObject(bytes, this.#schemas.offer).data.identity.$link !== identity.link) {
        throw new Error(`the Service of ${identity.link} lists an account offer that names another identity`);
      }
      const url = new URL(`/${accept}`, origin);
      account = new AccountOffer(
        { service: identity, offer: signature.object, url },
        this.#store,
        this.#authorizations,
        this.#schemas.acknowledgement,
      );
    }
    return { identity, origin, at, link, account };
  }
}

// Plain http is for the client's own machine alone, as in development: on
// first contact the origin is what makes a Service the service's, and only
// TLS says that an answer came from it.
function checkOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error(`a service is reached over https, or over http on this machine, not at ${origin}`);
  }
}

async function bundleIn(response: Response, statuses: readonly number[]): Promise<Bundle> {
  if (!statuses.includes(response.status)) {
    const reason = await response.text();
    throw new Error(`the service answered ${response.status}${reason === "" ? "" : `: ${reason}`}`);
  }
  const zip = await readBody(response.body, ANSWER_LIMIT);
  if (zip === undefined) throw new Error(`the service answered more than ${ANSWER_LIMIT} bytes`);
  return unpackBundle(zip);
}

/** Reaches mailbox services for the identities of the user of `store`, which keeps what it reaches. */
export async function loadServices(
  store: Store,
  { validator }: { readonly validator: JsonSchemaValidator },
): Promise<Services> {
  const authorizations = await loadAuthorizations(validator);
  const service: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, validator);
  const offer: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  return new Services(store, authorizations, { service, offer, acknowledgement });
}
