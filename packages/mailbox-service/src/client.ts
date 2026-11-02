import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  type IdentityKit,
  loadIdentity,
  noVersions,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
} from "@estoc/identity";
import type { Arrival, Pickup } from "@estoc/mailbox";
import { loadHttpTransport } from "@estoc/mailbox/http";
import {
  type Bytes,
  decodeObject,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type Json,
  type JsonLink,
  type JsonSchema,
  type JsonSchemaValidator,
  json,
  type Link,
  linkOf,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { type Store, view } from "@estoc/store";
import { hex } from "@scure/base";
import { acknowledgementAt, type OpenedMailboxes, openedMailboxes } from "./acknowledgements.ts";
import { PICKUP, readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
import { type KnownPeople, knownPeople } from "./people.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  type MailboxAcknowledgementData,
  type MailboxOfferData,
  type MailboxRequestData,
  type MailboxTerms,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
  type PickupRequestData,
  pickupRequestSchema,
  type ServiceData,
  serviceSchema,
  type WaitingData,
  waitingSchema,
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

type HttpMailboxData = { readonly key: string; readonly url: string };

type Schemas = {
  readonly service: Schema<Json, ServiceData>;
  readonly offer: Schema<Json, AccountOfferData>;
  readonly acknowledgement: Schema<Json, AcknowledgementData>;
  readonly mailboxOffer: Schema<Json, MailboxOfferData>;
  readonly mailboxRequest: Schema<Json, MailboxRequestData>;
  readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
  readonly pickupRequest: Schema<Json, PickupRequestData>;
  readonly waiting: Schema<Json, WaitingData>;
  /** The schema of the HTTP mailboxes of `@estoc/mailbox`, which senders post to. */
  readonly http: Schema<Json, HttpMailboxData>;
};

/** What an offer of a service's posts with: the store that keeps what the service answers, and how it reads that. */
type Posting = { readonly store: Store; readonly signatures: Signatures; readonly people: KnownPeople };

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
  /** The service's offer of mailboxes, or `undefined` when the Service lists none. */
  readonly mailbox: MailboxOffer | undefined;
}

/** A service's offer of an account, taken at the id that the Service lists for it. */
export class AccountOffer {
  /** The service's signed identity that signed the Service listing the offer, whose root the offer names. */
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<Json, AccountOfferData>>;
  readonly #url: URL;
  readonly #posting: Posting;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;

  constructor(
    { service, offer, url }: { readonly service: SignedIdentityObject; readonly offer: Link<never>; readonly url: URL },
    posting: Posting,
    acknowledgement: Schema<Json, AcknowledgementData>,
  ) {
    this.service = service;
    this.link = offer;
    this.#url = url;
    this.#posting = posting;
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
    const { signature, data } = await post(
      { url: this.#url, service: this.service, schema: this.#acknowledgementSchema, field: "acceptance" },
      acceptance,
      [],
      this.#posting,
    );
    return {
      signedIdentity: actor.signedIdentity,
      service: signature.signedIdentity,
      at: data.at,
      link: signature.link,
    };
  }
}

/**
 * A service's offer of mailboxes under an account there, on its terms,
 * taken at the id that the Service lists for it.
 */
export class MailboxOffer {
  /** The service's signed identity that signed the Service listing the offer, whose root the offer names. */
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<Json, MailboxOfferData>>;
  readonly terms: MailboxTerms;
  readonly #url: URL;
  readonly #posting: Posting;
  readonly #schemas: Pick<Schemas, "mailboxRequest" | "mailboxAcknowledgement" | "http">;

  constructor(
    {
      service,
      offer,
      url,
    }: {
      readonly service: SignedIdentityObject;
      readonly offer: EncodedObject<Json, MailboxOfferData>;
      readonly url: URL;
    },
    posting: Posting,
    schemas: Pick<Schemas, "mailboxRequest" | "mailboxAcknowledgement" | "http">,
  ) {
    const { identity: _, ...terms } = offer.data;
    this.service = service;
    this.link = offer.link;
    this.terms = terms;
    this.#url = url;
    this.#posting = posting;
    this.#schemas = schemas;
  }

  /**
   * Opens a mailbox sealed to `key`, an x25519 public key, under the account
   * of the root of the actor's identity, which the service opened before:
   * the actor signs a request for it, and the service acknowledges that
   * signature. Writes the service's signature over the acknowledgement to
   * the store as mine, with all it leads to, and gives the HTTP mailbox of
   * `@estoc/mailbox` that senders post to, at the origin the offer was
   * taken at. It is what `Post.openInbox` is to be given, as
   * `(publicKey) => offer.open(actor, publicKey)`.
   */
  async open(actor: Actor, key: Uint8Array): Promise<EncodedObject<Json, HttpMailboxData>> {
    const request = encodeObject(this.#schemas.mailboxRequest, { offer: { $link: this.link }, key: hex.encode(key) });
    // The service holds the offer and the schemas, so they are left out.
    const signature = await actor.sign(request);
    const { data } = await post(
      { url: this.#url, service: this.service, schema: this.#schemas.mailboxAcknowledgement, field: "request" },
      signature,
      [request.bytes],
      this.#posting,
    );
    return encodeObject(this.#schemas.http, {
      key: hex.encode(key),
      url: new URL(`/${data.send}`, this.#url.origin).href,
    });
  }
}

/**
 * Posts the bundle of `signature` to `url`, with `blobs` and the blobs of
 * its signed identity, and reads the answer as `service`'s signature over an
 * acknowledgement of it, written to `schema`, whose `field` links to it,
 * which is written to the store as mine with all it leads to. Refuses an
 * acknowledgement signed by another root, or of another signature, and
 * writes nothing then.
 */
async function post<K extends string, F extends Readonly<Record<K, JsonLink<Signature>>> & Fields<Json>>(
  to: {
    readonly url: URL;
    readonly service: SignedIdentityObject;
    readonly schema: Schema<Json, F>;
    readonly field: K;
  },
  signature: Signature,
  blobs: readonly Bytes<unknown>[],
  { store, signatures, people }: Posting,
): Promise<{ readonly signature: Signature; readonly data: F }> {
  const body = await packBundle(signature, [...blobs, ...signature.signedIdentity.blobs]);
  const request = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body };
  const answer = await bundleIn(await fetch(to.url, request), [200, 201]);
  const staged = await store.stage({ mine: [{ bytes: answer.root }], blobs: answer.blobs() });
  const known = await view(staged, people);
  const acknowledgement = await signatures.read(answer.link, staged, known);
  if (!known.personOf(to.service).signed(acknowledgement)) {
    throw new Error("the acknowledgement is signed by another root than the service's");
  }
  const { data } = await readObject(staged, acknowledgement.object, to.schema);
  const acknowledgedSignature = data[to.field].$link;
  if (acknowledgedSignature !== signature.link)
    throw new Error(`the acknowledgement is of ${acknowledgedSignature}, not the one sent`);
  await staged.commit();
  return { signature: acknowledgement, data };
}

/**
 * What waits at a mailbox that a service opened, which an actor for the
 * root of the mailbox's account picks up. Each request is signed, and
 * carries what was done since the one before, which the service drops
 * before it answers with what waits.
 */
class ServicePickup implements Pickup {
  readonly mailbox: Link<EncodedObject<Json>>;
  readonly #acknowledgement: Link<Signature>;
  readonly #url: URL;
  readonly #actor: Actor;
  readonly #limit: number;
  readonly #schemas: Pick<Schemas, "pickupRequest" | "waiting">;

  constructor(
    at: {
      readonly mailbox: Link<EncodedObject<Json>>;
      readonly acknowledgement: Link<Signature>;
      readonly url: URL;
      readonly size: number;
    },
    actor: Actor,
    schemas: Pick<Schemas, "pickupRequest" | "waiting">,
  ) {
    this.mailbox = at.mailbox;
    this.#acknowledgement = at.acknowledgement;
    this.#url = at.url;
    this.#actor = actor;
    // Room for the Waiting at the root, and for the zip around the sealed bytes.
    this.#limit = Math.max(PICKUP.bytes, at.size) + 64 * 1024;
    this.#schemas = schemas;
  }

  /**
   * Ends once an answer brings nothing that it has not handed out, and once
   * `signal` aborts. What is done once the last request is sent still waits.
   */
  async *arrivals(signal?: AbortSignal): AsyncGenerator<Arrival> {
    const handed = new Set<Link<Uint8Array>>();
    const done: Link<Uint8Array>[] = [];
    while (signal?.aborted !== true) {
      let waiting: Uint8Array[];
      try {
        waiting = await this.#pickUp(done.splice(0), signal);
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      const fresh = waiting.filter((sealed) => !handed.has(linkOf(sealed)));
      if (fresh.length === 0) return;
      for (const sealed of fresh) {
        if (signal?.aborted) return;
        const link = linkOf(sealed);
        handed.add(link);
        yield { sealed, drop: async () => void done.push(link) };
      }
    }
  }

  async #pickUp(done: readonly Link<Uint8Array>[], signal: AbortSignal | undefined): Promise<Uint8Array[]> {
    const request = encodeObject(this.#schemas.pickupRequest, {
      mailbox: { $link: this.#acknowledgement },
      done: done.map(($link) => ({ $link })),
    });
    const signature = await this.#actor.sign(request);
    const body = await packBundle(signature, [request.bytes, ...signature.signedIdentity.blobs]);
    const init = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body, signal: signal ?? null };
    const answer = await bundleIn(await fetch(this.#url, init), [200], this.#limit);
    const { sealed } = decodeObject(answer.root, this.#schemas.waiting).data;
    return sealed.map(({ $link }) => {
      const bytes = answer.get($link);
      if (bytes === undefined) throw new Error(`the service's answer lists ${$link} and does not hold it`);
      return bytes;
    });
  }
}

/**
 * Mailbox services as a client reaches them, with a store that keeps the
 * Services it reaches, the accounts it opens and the mailboxes.
 */
export class Services {
  readonly #store: Store;
  readonly #signatures: Signatures;
  readonly #schemas: Schemas;
  readonly #locations: Locations;
  readonly #mailboxes: OpenedMailboxes;
  readonly #people: KnownPeople;

  constructor(store: Store, kit: IdentityKit, schemas: Schemas) {
    this.#store = store;
    this.#signatures = kit.signatures;
    this.#schemas = schemas;
    this.#locations = locations(kit.signatures, schemas.service);
    this.#mailboxes = openedMailboxes(kit.signatures, schemas);
    this.#people = knownPeople(kit, schemas);
  }

  /**
   * Fetches the Service at `origin`, such as `https://mail.example`, and writes
   * the service's signature over it to the store as mine, with all it leads
   * to. What the origin answers over TLS is the service's, so the identity
   * that signed the Service is taken as the service's. A Service that names
   * another origin is refused.
   */
  async fetch(origin: string): Promise<Service> {
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
   * store holds none. A Service gets there by `fetch`, on this device or on
   * another whose store this one syncs with.
   */
  async latestOf(signedIdentity: SignedIdentityObject): Promise<Service | undefined> {
    const [latest] = await view(this.#store, servicesOf(this.#locations, signedIdentity.identity.root.link));
    return latest === undefined ? undefined : this.#read(latest, this.#store);
  }

  /**
   * What waits at `mailbox`, an HTTP mailbox that the store holds and that
   * a service opened, picked up by `actor`, an actor for the root of the
   * mailbox's account. The store holds the acknowledgement of the mailbox,
   * whose signer is the service; it is picked up where the latest Service
   * of the service that the store holds says, wherever the mailbox was
   * opened.
   */
  async pickup(mailbox: Link<EncodedObject<Json>>, actor: Actor): Promise<Pickup> {
    const { key, url } = (await readObject(this.#store, mailbox, this.#schemas.http)).data;
    const link = await view(this.#store, acknowledgementAt(this.#mailboxes, new URL(url).pathname.slice(1), key));
    if (link === undefined) throw new Error(`the store holds no acknowledgement of ${mailbox}`);
    // The acknowledgement was read by the people the store knew once it
    // came. Here it says only where to pick up, which a later version of the
    // service's identity that does not list the key that signed it does not
    // change.
    const { signedIdentity, object } = await this.#signatures.read(link, this.#store, noVersions);
    const { request, pickup } = (await readObject(this.#store, object, this.#schemas.mailboxAcknowledgement)).data;
    const { object: requestObject } = (await readObject(this.#store, request.$link, this.#signatures.schema)).data;
    const { offer } = (await readObject(this.#store, requestObject.$link, this.#schemas.mailboxRequest)).data;
    const { size } = (await readObject(this.#store, offer.$link, this.#schemas.mailboxOffer)).data;
    const service = await this.latestOf(signedIdentity);
    if (service === undefined) throw new Error(`the store holds no Service of ${signedIdentity.identity.root.link}`);
    const at = { mailbox, acknowledgement: link, url: new URL(`/${pickup}`, service.origin), size };
    return new ServicePickup(at, actor, this.#schemas);
  }

  /**
   * Reads the Service that `link` names the service's signature over, and
   * the offers it lists, from `reader`, by the people it knows. `fetch`
   * reads it on the store as it will be once it keeps the Service, so the
   * version that signed the Service is among them, and an offer is read by
   * that version or a later one. A Service that `fetch` takes so reads alike
   * by `latestOf` until the store knows a later version of the service's
   * identity. Refuses it when its origin is not one that a client reaches,
   * when an offer it lists is signed by an identity of another root, or when
   * its offer of an account or of mailboxes names another root. Offers of
   * schemas the client does not read are passed over.
   */
  async #read(link: Link<Signature>, reader: Pick<Store, "get" | "mine">): Promise<Service> {
    const people = await view(reader, this.#people);
    const { signedIdentity, object } = await this.#signatures.read(link, reader, people);
    const service = people.personOf(signedIdentity);
    const { root } = service;
    const { origin, at, offers } = (await readObject(reader, object, this.#schemas.service)).data;
    checkOrigin(origin);
    const posting = { store: this.#store, signatures: this.#signatures, people: this.#people };
    let account: AccountOffer | undefined;
    let mailbox: MailboxOffer | undefined;
    for (const { offer, accept } of offers) {
      const signature = await this.#signatures.read(offer.$link, reader, people);
      if (!service.signed(signature))
        throw new Error(`the Service of ${root.link} lists an offer signed by another root`);
      const bytes = await reader.get(signature.object);
      if (bytes === undefined) throw new Error(`no blob is given for ${signature.object}`);
      const schema = schemaOf(bytes, json);
      const url = new URL(`/${accept}`, origin);
      if (account === undefined && schema === this.#schemas.offer.link) {
        if (decodeObject(bytes, this.#schemas.offer).data.identity.$link !== root.link) {
          throw new Error(`the Service of ${root.link} lists an account offer that names another root`);
        }
        const offered = { service: signedIdentity, offer: signature.object, url };
        account = new AccountOffer(offered, posting, this.#schemas.acknowledgement);
      } else if (mailbox === undefined && schema === this.#schemas.mailboxOffer.link) {
        const read = decodeObject(bytes, this.#schemas.mailboxOffer);
        if (read.data.identity.$link !== root.link) {
          throw new Error(`the Service of ${root.link} lists a mailbox offer that names another root`);
        }
        mailbox = new MailboxOffer({ service: signedIdentity, offer: read, url }, posting, this.#schemas);
      }
    }
    return { signedIdentity, origin, at, link, account, mailbox };
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

async function bundleIn(response: Response, statuses: readonly number[], limit = ANSWER_LIMIT): Promise<Bundle> {
  if (!statuses.includes(response.status)) {
    const reason = await response.text();
    throw new Error(`the service answered ${response.status}${reason === "" ? "" : `: ${reason}`}`);
  }
  const zip = await readBody(response.body, limit);
  if (zip === undefined) throw new Error(`the service answered more than ${limit} bytes`);
  return unpackBundle(zip);
}

/** Reaches mailbox services for the identities of the user of `store`, which keeps what it reaches. */
export async function loadServices(
  store: Store,
  { validator }: { readonly validator: JsonSchemaValidator },
): Promise<Services> {
  const kit = await loadIdentity(validator);
  const compile = <F extends Fields<Json>>(schema: JsonSchema): Promise<Schema<Json, F>> =>
    encodeSchema(schema, validator);
  // The HTTP transport's schema is read as the fields every HTTP mailbox has.
  const http = (await loadHttpTransport(validator)).schema as Schema<Json, HttpMailboxData>;
  return new Services(store, kit, {
    service: await compile(serviceSchema),
    offer: await compile(accountOfferSchema),
    acknowledgement: await compile(acknowledgementSchema),
    mailboxOffer: await compile(mailboxOfferSchema),
    mailboxRequest: await compile(mailboxRequestSchema),
    mailboxAcknowledgement: await compile(mailboxAcknowledgementSchema),
    pickupRequest: await compile(pickupRequestSchema),
    waiting: await compile(waitingSchema),
    http,
  });
}
