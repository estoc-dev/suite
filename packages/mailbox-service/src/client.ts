import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  type IdentityKit,
  loadIdentity,
  noIdentityVersions,
  type Scheme,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
} from "@estoc/identity";
import type { Arrival, Pickup } from "@estoc/mailbox";
import { httpTransport } from "@estoc/mailbox/http";
import {
  type Bytes,
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Fields,
  type Json,
  type JsonLink,
  json,
  type Link,
  linkOf,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { Intake, type Store, view } from "@estoc/store";
import { hex } from "@scure/base";
import { type OpenedMailboxesView, openedMailboxesView } from "./acknowledgements.ts";
import { PICKUP, readBody, ZIP } from "./http.ts";
import { type LocationsView, locationsView } from "./locations.ts";
import { type PeopleView, peopleView } from "./people.ts";
import {
  type AccountOfferData,
  accountOfferSchema,
  acknowledgementSchema,
  type MailboxOfferData,
  type MailboxTerms,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
  type OriginData,
  openedMailboxSchema,
  originSchema,
  pickupAnswerSchema,
  pickupRequestSchema,
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

type HttpMailboxData = { readonly key: string; readonly url: string };

// The HTTP transport's schema, read as the fields every HTTP mailbox has.
const httpMailboxSchema = httpTransport.schema as Schema<Json, HttpMailboxData>;

/**
 * What an offer of a service's posts with. Its `origin` is where the offer
 * was taken, which a Service that the service signs later at another origin
 * does not change.
 */
type Posting = {
  readonly store: Store;
  readonly intake: Intake;
  readonly origin: EncodedObject<Json, OriginData>;
  readonly signatures: Signatures;
  readonly people: PeopleView;
};

/** An acceptance of a service's offer, acknowledged, for the account of whoever accepted. */
export interface Account {
  /** The signed identity of the actor that accepted the offer, whose identifier the account is of. */
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

/** A service's offer of an account, taken at its id, which is its link. */
export class AccountOffer {
  /** The service's signed identity that signed the Service listing the offer, whose identifier the offer names. */
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<Json, AccountOfferData>>;
  readonly #url: URL;
  readonly #posting: Posting;

  constructor(
    { service, offer, url }: { readonly service: SignedIdentityObject; readonly offer: Link<never>; readonly url: URL },
    posting: Posting,
  ) {
    this.service = service;
    this.link = offer;
    this.#url = url;
    this.#posting = posting;
  }

  /**
   * Accepts the offer for whoever the actor signs for, which opens their
   * account unless they have one there.
   *
   * - The actor signs the offer, and the service acknowledges that signature.
   * - The service's signature over the acknowledgement is kept in the store
   *   with an Inbound record whose `via` is the origin the offer was taken
   *   at.
   *
   * @throws when the service refuses the acceptance, or when its
   *   acknowledgement is signed for another identifier than the service's or
   *   is of another signature. Nothing is written then.
   */
  async accept(actor: Actor): Promise<Account> {
    // The service holds the offer and the signature schema, so they are left out.
    const acceptance = await actor.sign({ link: this.link });
    const { signature, data } = await post(
      { url: this.#url, service: this.service, schema: acknowledgementSchema, field: "acceptance" },
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
 * taken at its id, which is its link.
 */
export class MailboxOffer {
  /** The service's signed identity that signed the Service listing the offer, whose identifier the offer names. */
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<Json, MailboxOfferData>>;
  readonly terms: MailboxTerms;
  readonly #url: URL;
  readonly #posting: Posting;

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
  ) {
    const { identity: _, ...terms } = offer.data;
    this.service = service;
    this.link = offer.link;
    this.terms = terms;
    this.#url = url;
    this.#posting = posting;
  }

  /**
   * Opens a mailbox sealed to `key`, an x25519 public key, under the account
   * of whoever the actor signs for, which the service opened before.
   *
   * - The actor signs a request for it, and the service acknowledges that
   *   signature.
   * - The service's signature over the acknowledgement is kept in the store
   *   with an Inbound record whose `via` is the origin the offer was taken
   *   at, and then with an Opened mailbox record, which `pickup` goes by.
   * - It gives the HTTP mailbox of `@estoc/mailbox` that senders post to, at
   *   the origin the offer was taken at. It is what `Post.openInbox` is to be
   *   given, as `(publicKey) => offer.open(actor, publicKey)`.
   *
   * @throws when the service refuses the request, or when its
   *   acknowledgement is signed for another identifier than the service's or
   *   is of another signature. Nothing is written then.
   */
  async open(actor: Actor, key: Uint8Array): Promise<EncodedObject<Json, HttpMailboxData>> {
    const request = encodeObject(mailboxRequestSchema, { offer: { $link: this.link }, key: hex.encode(key) });
    // The service holds the offer and the schemas, so they are left out.
    const signature = await actor.sign(request);
    const { signature: acknowledgement, data } = await post(
      { url: this.#url, service: this.service, schema: mailboxAcknowledgementSchema, field: "request" },
      signature,
      [request.bytes],
      this.#posting,
    );
    const mailbox = encodeObject(httpMailboxSchema, {
      key: hex.encode(key),
      url: new URL(`/${data.sendId}`, this.#url.origin).href,
    });
    const openedMailbox = encodeObject(openedMailboxSchema, {
      mailbox: { $link: mailbox.link },
      acknowledgement: { $link: acknowledgement.link },
    });
    await this.#posting.store.write({
      records: [openedMailbox],
      blobs: [mailbox.bytes, ...mailbox.schema.blobs, ...openedMailbox.schema.blobs],
    });
    return mailbox;
  }
}

/**
 * Posts the bundle of `signature` to `url`, with `blobs` and the blobs of
 * its signed identity, and keeps the answer in the store with an Inbound
 * record whose `via` is the posting's origin.
 *
 * The answer is read as `service`'s signature over an acknowledgement of
 * `signature`, written to `schema`, whose `field` links to it.
 *
 * @throws when the service answers another status than 200 or 201, or when
 *   the acknowledgement is signed for another identifier than the service's
 *   or is of another signature. Nothing is written then.
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
  { store, intake, origin, signatures, people }: Posting,
): Promise<{ readonly signature: Signature; readonly data: F }> {
  const body = await packBundle(signature, [...blobs, ...signature.signedIdentity.blobs]);
  const request = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body };
  const answer = await bundleIn(await fetch(to.url, request), [200, 201]);
  const stagedStore = await store.stage({ records: [{ bytes: answer.root }], blobs: answer.blobs() });
  const stagedPeople = await view(stagedStore, people);
  const acknowledgement = await signatures.read(answer.link, stagedStore, stagedPeople);
  if (!stagedPeople.personOf(to.service).hasSigned(acknowledgement)) {
    throw new Error("the acknowledgement is signed for another identifier than the service's");
  }
  const { data } = await readObject(stagedStore, acknowledgement.object, to.schema);
  const acknowledgedSignature = data[to.field].$link;
  if (acknowledgedSignature !== signature.link)
    throw new Error(`the acknowledgement is of ${acknowledgedSignature}, not the one sent`);
  await intake.receive(answer, origin);
  return { signature: acknowledgement, data };
}

/**
 * What waits at a mailbox that a service opened, which an actor for the
 * mailbox's account picks up.
 *
 * Each request is signed, and carries receipts for what was dropped since
 * the one before, which the service drops before it answers with what waits.
 */
class ServicePickup implements Pickup {
  readonly mailbox: Link<EncodedObject<Json>>;
  readonly #request: Link<Signature>;
  readonly #url: URL;
  readonly #actor: Actor;
  readonly #limit: number;

  constructor(
    target: {
      readonly mailbox: Link<EncodedObject<Json>>;
      readonly request: Link<Signature>;
      readonly url: URL;
      readonly size: number;
    },
    actor: Actor,
  ) {
    this.mailbox = target.mailbox;
    this.#request = target.request;
    this.#url = target.url;
    this.#actor = actor;
    // Room for the Pickup answer at the root, and for the zip around the ciphertexts.
    this.#limit = Math.max(PICKUP.bytes, target.size) + 64 * 1024;
  }

  /**
   * Hands out each ciphertext that waits once, and asks again after each
   * answer.
   *
   * - It ends once an answer brings nothing that it has not handed out, and
   *   once `signal` aborts.
   * - What is dropped once the last request is sent still waits.
   *
   * @throws when a pickup fails before `signal` aborts.
   */
  async *arrivals(signal?: AbortSignal): AsyncGenerator<Arrival> {
    const handedLinks = new Set<Link<Uint8Array>>();
    const receipts: Link<Uint8Array>[] = [];
    while (signal?.aborted !== true) {
      let queue: Uint8Array[];
      try {
        queue = await this.#pickUp(receipts.splice(0), signal);
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      const newCiphertexts = queue.filter((ciphertext) => !handedLinks.has(linkOf(ciphertext)));
      if (newCiphertexts.length === 0) return;
      for (const ciphertext of newCiphertexts) {
        if (signal?.aborted) return;
        const link = linkOf(ciphertext);
        handedLinks.add(link);
        yield { ciphertext, drop: async () => void receipts.push(link) };
      }
    }
  }

  async #pickUp(receipts: readonly Link<Uint8Array>[], signal: AbortSignal | undefined): Promise<Uint8Array[]> {
    const request = encodeObject(pickupRequestSchema, {
      mailbox: { $link: this.#request },
      receipts: receipts.map(($link) => ({ $link })),
    });
    const signature = await this.#actor.sign(request);
    const body = await packBundle(signature, [request.bytes, ...signature.signedIdentity.blobs]);
    const init = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body, signal: signal ?? null };
    const answer = await bundleIn(await fetch(this.#url, init), [200], this.#limit);
    const { ciphertexts } = decodeObject(answer.root, pickupAnswerSchema).data;
    return ciphertexts.map(({ $link }) => {
      const bytes = answer.get($link);
      if (bytes === undefined) throw new Error(`the service's answer lists ${$link} and does not hold it`);
      return bytes;
    });
  }
}

/**
 * Mailbox services as a client reaches them, with a store that keeps the
 * Services it reaches, the accounts it opens and the mailboxes.
 *
 * - What a service answers is kept with an Inbound record of `@estoc/store`
 *   whose `via` is the Origin it was reached at.
 * - It reads Services back from the signatures the store holds, records or
 *   not, so one that came in another way, such as at a mailbox, reads alike.
 * - It reads the mailboxes it opened back from the Opened mailbox records
 *   that `open` writes.
 */
export class Services {
  readonly #store: Store;
  readonly #intake: Intake;
  readonly #signatures: Signatures;
  readonly #locations: LocationsView;
  readonly #mailboxes: OpenedMailboxesView;
  readonly #people: PeopleView;

  constructor(store: Store, intake: Intake, kit: IdentityKit) {
    this.#store = store;
    this.#intake = intake;
    this.#signatures = kit.signatures;
    this.#locations = locationsView(kit.signatures);
    this.#mailboxes = openedMailboxesView();
    this.#people = peopleView(kit.identityVersions);
  }

  /**
   * Fetches the Service at `origin`, such as `https://mail.example`, and
   * keeps the service's signature over it in the store with an Inbound
   * record whose `via` is `origin`.
   *
   * What the origin answers over TLS is the service's, so the identity that
   * signed the Service is taken as the service's.
   *
   * @throws when `origin` is not an https origin or an http one on this
   *   machine, when the service answers another status than 200, when the
   *   Service names another origin, or when it lists an offer signed for
   *   another identifier or one that names another identifier. Nothing is
   *   written then.
   */
  async fetch(origin: string): Promise<Service> {
    checkOrigin(origin);
    const bundle = await bundleIn(await fetch(new URL("/", origin), REQUEST), [200]);
    const stagedStore = await this.#store.stage({ records: [{ bytes: bundle.root }], blobs: bundle.blobs() });
    const service = await this.#read(bundle.link, stagedStore);
    if (service.origin !== origin) throw new Error(`the Service at ${origin} names ${service.origin}`);
    await this.#intake.receive(bundle, this.#originOf(origin));
    return service;
  }

  /**
   * The latest Service of the person of `signedIdentity` that the store
   * holds, read without reaching the service, or `undefined` when the
   * store holds none that is honored.
   *
   * - A Service is honored however it came, by `fetch` or at a mailbox, on this
   *   device or on another whose store this one syncs with.
   * - Only a Service signed by a key that the current identity version the
   *   store holds lists is honored, so one that a key taken out signs after does
   *   not stand in for the service, whatever its `at`.
   *
   * @throws when the latest Service is one that `fetch` refuses, apart from
   *   naming another origin than the one asked.
   */
  async latestOf(signedIdentity: SignedIdentityObject): Promise<Service | undefined> {
    const locations = await view(this.#store, this.#locations);
    const people = await view(this.#store, this.#people);
    const [latest] = await locations.servicesOf(signedIdentity.identity.identifier, people);
    return latest === undefined ? undefined : this.#read(latest, this.#store);
  }

  /**
   * What waits at `mailbox`, an HTTP mailbox that a service opened, picked
   * up by `actor`, an actor for the mailbox's account.
   *
   * - It goes by the acknowledgement that the Opened mailbox record of
   *   `mailbox` links to, which `open` wrote on this device or on another
   *   whose store this one syncs with. One that came in another way, such
   *   as at a mailbox, does not stand in for it.
   * - A later identity version of the account that takes out the key that
   *   signed the request does not change it, so the mailbox stays the
   *   account's.
   * - It is picked up where the latest Service that the store holds of the
   *   service that signed the acknowledgement says, wherever the mailbox was
   *   opened.
   *
   * @throws when the store holds no Opened mailbox record of `mailbox`, or
   *   no Service of the service that signed its acknowledgement.
   */
  async pickup(mailbox: Link<EncodedObject<Json>>, actor: Actor): Promise<Pickup> {
    const link = await (await view(this.#store, this.#mailboxes)).acknowledgementOf(mailbox);
    if (link === undefined) throw new Error(`the store holds no record of opening ${mailbox}`);
    // It says only where to pick up, which a later identity version of the
    // service that does not list the key that signed it does not change.
    const { signedIdentity, object } = await this.#signatures.read(link, this.#store, noIdentityVersions);
    const { request, pickupId } = (await readObject(this.#store, object, mailboxAcknowledgementSchema)).data;
    const { object: requestObject } = (await readObject(this.#store, request.$link, this.#signatures.schema)).data;
    const { offer } = (await readObject(this.#store, requestObject.$link, mailboxRequestSchema)).data;
    const { size } = (await readObject(this.#store, offer.$link, mailboxOfferSchema)).data;
    const service = await this.latestOf(signedIdentity);
    if (service === undefined) throw new Error(`the store holds no Service of ${signedIdentity.identity.identifier}`);
    const target = { mailbox, request: request.$link, url: new URL(`/${pickupId}`, service.origin), size };
    return new ServicePickup(target, actor);
  }

  /**
   * Reads the Service that the service's signature at `link` is over, and the
   * offers it lists, from `reader`, verified against the identity versions
   * that `reader` holds.
   *
   * - `fetch` reads it on the store as it will be once it keeps the Service,
   *   so the identity version that signed the Service is among those, and an
   *   offer is verified by that identity version or a later one.
   * - A Service that `fetch` takes so reads alike by `latestOf` until the
   *   store holds a later identity version of the service.
   * - Offers of schemas the client does not read are passed over.
   *
   * @throws when the Service's origin is not one that a client reaches, when
   *   an offer it lists is signed for another identifier, or when its offer
   *   of an account or of mailboxes names another identifier.
   */
  async #read(link: Link<Signature>, reader: Pick<Store, "get" | "records" | "positionOf">): Promise<Service> {
    const people = await view(reader, this.#people);
    const { signedIdentity, object } = await this.#signatures.read(link, reader, people);
    const service = people.personOf(signedIdentity);
    const { identifier } = service;
    const { origin, at, offers } = (await readObject(reader, object, serviceSchema)).data;
    checkOrigin(origin);
    const posting = {
      store: this.#store,
      intake: this.#intake,
      origin: this.#originOf(origin),
      signatures: this.#signatures,
      people: this.#people,
    };
    let account: AccountOffer | undefined;
    let mailbox: MailboxOffer | undefined;
    for (const { $link } of offers) {
      const signature = await this.#signatures.read($link, reader, people);
      if (!service.hasSigned(signature))
        throw new Error(`the Service of ${identifier} lists an offer signed for another identifier`);
      const bytes = await reader.get(signature.object);
      if (bytes === undefined) throw new Error(`no blob is given for ${signature.object}`);
      const schema = schemaOf(bytes, json);
      const url = new URL(`/${signature.object}`, origin);
      if (account === undefined && schema === accountOfferSchema.link) {
        if (decodeObject(bytes, accountOfferSchema).data.identity.$link !== identifier) {
          throw new Error(`the Service of ${identifier} lists an account offer that names another identifier`);
        }
        account = new AccountOffer({ service: signedIdentity, offer: signature.object, url }, posting);
      } else if (mailbox === undefined && schema === mailboxOfferSchema.link) {
        const decodedOffer = decodeObject(bytes, mailboxOfferSchema);
        if (decodedOffer.data.identity.$link !== identifier) {
          throw new Error(`the Service of ${identifier} lists a mailbox offer that names another identifier`);
        }
        mailbox = new MailboxOffer({ service: signedIdentity, offer: decodedOffer, url }, posting);
      }
    }
    return { signedIdentity, origin, at, link, account, mailbox };
  }

  #originOf(origin: string): EncodedObject<Json, OriginData> {
    return encodeObject(originSchema, { origin });
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

/**
 * Reaches mailbox services for the identities of the user of `store`, which
 * keeps what it reaches, reading keys in `schemes`. `clock` gives the time
 * in milliseconds since the Unix epoch that the Inbound records are written
 * at, `Date.now` unless given.
 */
export async function loadServices(
  store: Store,
  { schemes, clock = Date.now }: { readonly schemes: readonly Scheme[]; readonly clock?: () => number },
): Promise<Services> {
  return new Services(store, new Intake(store, clock), await loadIdentity(schemes));
}
