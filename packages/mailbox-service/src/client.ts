import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  type IdentityKit,
  loadIdentity,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
} from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  encodeSchema,
  type Json,
  type JsonSchemaValidator,
  json,
  type Link,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { type Store, view } from "@estoc/store";
import { readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
import { type KnownPeople, knownPeople } from "./people.ts";
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

/** An acceptance of a service's offer, acknowledged, for the account of the root of the identity that accepted. */
export interface Account {
  /** The signed identity of the actor that accepted the offer, whose root the account is of. */
  readonly signedIdentity: SignedIdentityObject;
  /** The service's signed identity that signed the acknowledgement. */
  readonly service: SignedIdentityObject;
  /** When the service received the acceptance, in milliseconds since the Unix epoch by the service's clock. */
  readonly at: number;
  /** The link of the service's signature over the acknowledgement. */
  readonly link: Link<Signature>;
}

/** A service as one of its Services says: where its identity is reached, and what it offers there. */
export interface Service {
  /** The service's signed identity that signed the Service. */
  readonly signedIdentity: SignedIdentityObject;
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
  /** The service's signed identity that signed the Service listing the offer, whose root the offer names. */
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<Json, AccountOfferData>>;
  readonly #url: URL;
  readonly #store: Store;
  readonly #signatures: Signatures;
  readonly #people: KnownPeople;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;

  constructor(
    { service, offer, url }: { readonly service: SignedIdentityObject; readonly offer: Link<never>; readonly url: URL },
    {
      store,
      signatures,
      people,
    }: { readonly store: Store; readonly signatures: Signatures; readonly people: KnownPeople },
    acknowledgement: Schema<Json, AcknowledgementData>,
  ) {
    this.service = service;
    this.link = offer;
    this.#url = url;
    this.#store = store;
    this.#signatures = signatures;
    this.#people = people;
    this.#acknowledgementSchema = acknowledgement;
  }

  /**
   * Accepts the offer for the root of the actor's identity, which opens its
   * account unless the root has one there: the actor signs the offer, and
   * the service acknowledges that signature. Writes the service's signature
   * over the acknowledgement to the store as mine, with all it leads to.
   */
  async accept(actor: Actor): Promise<Account> {
    // The service holds the offer and the signature schema, so they are left out.
    const acceptance = await actor.sign({ link: this.link });
    const body = await packBundle(acceptance, acceptance.signedIdentity.blobs);
    const request = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body };
    const answer = await bundleIn(await fetch(this.#url, request), [200, 201]);
    const staged = await this.#store.stage({ mine: [{ bytes: answer.root }], blobs: answer.blobs() });
    const people = await view(staged, this.#people);
    const acknowledgement = await this.#signatures.read(answer.link, staged, people);
    if (!people.of(this.service).signed(acknowledgement)) {
      throw new Error("the acknowledgement is signed by another root than the service's");
    }
    const { accepted, at } = (await readObject(staged, acknowledgement.object, this.#acknowledgementSchema)).data;
    if (accepted.$link !== acceptance.link)
      throw new Error(`the acknowledgement accepts ${accepted.$link}, not the acceptance sent`);
    await staged.commit();
    return {
      signedIdentity: actor.signedIdentity,
      service: acknowledgement.signedIdentity,
      at,
      link: acknowledgement.link,
    };
  }
}

/**
 * Mailbox services as a client reaches them, with a store that keeps the
 * Services it reaches and the accounts it opens.
 */
export class Services {
  readonly #store: Store;
  readonly #signatures: Signatures;
  readonly #schemas: Schemas;
  readonly #locations: Locations;
  readonly #people: KnownPeople;

  constructor(store: Store, kit: IdentityKit, schemas: Schemas) {
    this.#store = store;
    this.#signatures = kit.signatures;
    this.#schemas = schemas;
    this.#locations = locations(kit.signatures, schemas.service);
    this.#people = knownPeople(kit, schemas);
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
    const staged = await this.#store.stage({ mine: [{ bytes: bundle.root }], blobs: bundle.blobs() });
    const service = await this.#read(bundle.link, staged);
    if (service.origin !== origin) throw new Error(`the Service at ${origin} names ${service.origin}`);
    await staged.commit();
    return service;
  }

  /**
   * The latest Service of the root that signed `signedIdentity` that the
   * store holds, read without reaching the service, or `undefined` when the
   * store holds none. A Service gets there by `at`, on this device or on
   * another whose store this one syncs with.
   */
  async of(signedIdentity: SignedIdentityObject): Promise<Service | undefined> {
    const [latest] = await view(this.#store, servicesOf(this.#locations, signedIdentity.identity.root.link));
    return latest === undefined ? undefined : this.#read(latest, this.#store);
  }

  /**
   * Reads the Service that `link` names the service's signature over, and
   * the offers it lists, from `reader`, by the people it knows. `at` reads
   * it on the store as it will be once it keeps the Service, so the version
   * that signed the Service is among them, and an offer is read by that
   * version or a later one. A Service that `at` takes so reads alike by `of`
   * until the store knows a later version of the service's identity.
   * Refuses it when its origin is
   * not one that a client reaches, when an offer it lists is signed by an
   * identity of another root, or when its offer of an account names another
   * root. Offers of schemas the client does not read are passed over.
   */
  async #read(link: Link<Signature>, reader: Pick<Store, "get" | "mine">): Promise<Service> {
    const people = await view(reader, this.#people);
    const { signedIdentity, object } = await this.#signatures.read(link, reader, people);
    const service = people.of(signedIdentity);
    const { root } = service;
    const { origin, at, offers } = (await readObject(reader, object, this.#schemas.service)).data;
    checkOrigin(origin);
    let account: AccountOffer | undefined;
    for (const { offer, accept } of offers) {
      const signature = await this.#signatures.read(offer.$link, reader, people);
      if (!service.signed(signature))
        throw new Error(`the Service of ${root.link} lists an offer signed by another root`);
      const bytes = await reader.get(signature.object);
      if (bytes === undefined) throw new Error(`no blob is given for ${signature.object}`);
      if (account !== undefined || schemaOf(bytes, json) !== this.#schemas.offer.link) continue;
      if (decodeObject(bytes, this.#schemas.offer).data.identity.$link !== root.link) {
        throw new Error(`the Service of ${root.link} lists an account offer that names another root`);
      }
      const url = new URL(`/${accept}`, origin);
      account = new AccountOffer(
        { service: signedIdentity, offer: signature.object, url },
        { store: this.#store, signatures: this.#signatures, people: this.#people },
        this.#schemas.acknowledgement,
      );
    }
    return { signedIdentity, origin, at, link, account };
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
  const kit = await loadIdentity(validator);
  const service: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, validator);
  const offer: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  return new Services(store, kit, { service, offer, acknowledgement });
}
