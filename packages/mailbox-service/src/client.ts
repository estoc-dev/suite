import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type Actor,
  type IdentityKit,
  loadIdentity,
  type Scheme,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
} from "@estoc/identity";
import type { Arrival, Pickup } from "@estoc/mailbox";
import { httpTransport } from "@estoc/mailbox/http";
import {
  AbsentBlob,
  type Bytes,
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  readObject,
  type Schema,
  schemaOf,
  type ValueMap,
} from "@estoc/object";
import { checkHonors, type PeopleView, peopleView } from "@estoc/people";
import type { DataOf } from "@estoc/schema";
import { Intake, type PrivateStore, type StagedStore, type Store, view } from "@estoc/store";
import { hex } from "@scure/base";
import { type OpenedMailboxesView, openedMailboxesView } from "./acknowledgements.ts";
import { BUNDLE_TYPE, PICKUP, readBody } from "./http.ts";
import { type LocationsView, locationsView } from "./locations.ts";
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

type HttpMailboxData = DataOf<typeof httpTransport.schema>;

/**
 * `origin` is where the offer was taken, which a Service that the service signs later at another
 * origin does not change.
 */
type Posting = {
  readonly store: Store;
  readonly privateStore: PrivateStore;
  readonly intake: Intake;
  readonly origin: EncodedObject<OriginData>;
  readonly signatures: Signatures;
  readonly people: PeopleView;
};

export interface Account {
  readonly signedIdentity: SignedIdentityObject;
  readonly service: SignedIdentityObject;
  readonly at: number;
  readonly link: Link<unknown>;
}

export interface Service {
  readonly signedIdentity: SignedIdentityObject;
  readonly origin: string;
  readonly at: number;
  readonly link: Link<unknown>;
  readonly account: AccountOffer | undefined;
  readonly mailbox: MailboxOffer | undefined;
}

export class AccountOffer {
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<AccountOfferData>>;
  readonly #url: URL;
  readonly #posting: Posting;

  constructor(
    {
      service,
      offer,
      url,
    }: {
      readonly service: SignedIdentityObject;
      readonly offer: Link<EncodedObject<AccountOfferData>>;
      readonly url: URL;
    },
    posting: Posting,
  ) {
    this.service = service;
    this.link = offer;
    this.#url = url;
    this.#posting = posting;
  }

  async accept(actor: Actor): Promise<Account> {
    // The service holds the offer, so it is left out.
    const acceptance = await actor.sign({ link: this.link });
    const { signature, data } = await post(
      { url: this.#url, service: this.service, schema: acknowledgementSchema, field: "acceptance" },
      acceptance,
      [],
      this.#posting,
    );
    return {
      signedIdentity: acceptance.signedIdentity,
      service: signature.signedIdentity,
      at: data.at,
      link: signature.link,
    };
  }
}

export class MailboxOffer {
  readonly service: SignedIdentityObject;
  readonly link: Link<EncodedObject<MailboxOfferData>>;
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
      readonly offer: EncodedObject<MailboxOfferData>;
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

  async open(actor: Actor, key: Uint8Array): Promise<EncodedObject<HttpMailboxData>> {
    const request = encodeObject(mailboxRequestSchema, { offer: new LinkValue(this.link), key });
    // The service holds the offer and the schemas, so they are left out.
    const signature = await actor.sign(request);
    const { signature: acknowledgement, data } = await post(
      { url: this.#url, service: this.service, schema: mailboxAcknowledgementSchema, field: "request" },
      signature,
      [request.bytes],
      this.#posting,
    );
    const mailbox = encodeObject(httpTransport.schema, {
      key,
      url: new URL(`/${hex.encode(data.sendId)}`, this.#url.origin).href,
    });
    const openedMailbox = encodeObject(openedMailboxSchema, {
      mailbox: new LinkValue(mailbox.link),
      acknowledgement: new LinkValue(acknowledgement.link),
    });
    const { store, privateStore } = this.#posting;
    await store.write({ roots: [mailbox.link], blobs: [mailbox.bytes, ...mailbox.schema.blobs] });
    await privateStore.write({
      marks: [openedMailbox.link],
      blobs: [openedMailbox.bytes, ...openedMailbox.schema.blobs],
    });
    return mailbox;
  }
}

async function post<K extends string, F extends Readonly<Record<K, LinkValue<unknown>>> & ValueMap>(
  to: {
    readonly url: URL;
    readonly service: SignedIdentityObject;
    readonly schema: Schema<F>;
    readonly field: K;
  },
  signature: Signature,
  blobs: readonly Bytes<unknown>[],
  { intake, origin, signatures, people }: Posting,
): Promise<{ readonly signature: Signature; readonly data: F }> {
  const answer = await postSigned(to.url, signature, blobs, { statuses: [200, 201] });
  const stagedStore = await intake.stage(answer, origin);
  const stagedPeople = await view(stagedStore, people);
  const acknowledgement = await signatures.read(answer.link, stagedStore);
  await checkHonors(stagedPeople, acknowledgement);
  if (!stagedPeople.personOf(to.service).hasSigned(acknowledgement)) {
    throw new Error("the acknowledgement is signed for another identifier than the service's");
  }
  const { data } = await readObject(stagedStore, acknowledgement.object, to.schema);
  const acknowledgedSignature = data[to.field].link;
  if (acknowledgedSignature !== signature.link)
    throw new Error(`the acknowledgement is of ${acknowledgedSignature}, not the one sent`);
  await stagedStore.commit();
  return { signature: acknowledgement, data };
}

class ServicePickup implements Pickup {
  readonly mailbox: Link<EncodedObject>;
  readonly #request: Link<unknown>;
  readonly #url: URL;
  readonly #actor: Actor;
  readonly #limit: number;

  constructor(
    target: {
      readonly mailbox: Link<EncodedObject>;
      readonly request: Link<unknown>;
      readonly url: URL;
      readonly size: number;
    },
    actor: Actor,
  ) {
    this.mailbox = target.mailbox;
    this.#request = target.request;
    this.#url = target.url;
    this.#actor = actor;
    // Room for the Pickup answer at the root, and for the head of the byte string around each ciphertext.
    this.#limit = Math.max(PICKUP.bytes, target.size) + 64 * 1024;
  }

  /** What is dropped once the last request is sent still waits. */
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
      mailbox: new LinkValue(this.#request),
      receipts: receipts.map((receipt) => new LinkValue(receipt)),
    });
    const signature = await this.#actor.sign(request);
    const answer = await postSigned(this.#url, signature, [request.bytes], {
      statuses: [200],
      limit: this.#limit,
      signal,
    });
    const { ciphertexts } = decodeObject(answer.root, pickupAnswerSchema).data;
    return ciphertexts.map(({ link }) => {
      const bytes = answer.get(link);
      if (bytes === undefined) throw new Error(`the service's answer lists ${link} and does not hold it`);
      return bytes;
    });
  }
}

export class Services {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #intake: Intake;
  readonly #signatures: Signatures;
  readonly #locations: LocationsView;
  readonly #mailboxes: OpenedMailboxesView;
  readonly #people: PeopleView;

  constructor(store: Store, privateStore: PrivateStore, intake: Intake, kit: IdentityKit) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#intake = intake;
    this.#signatures = kit.signatures;
    this.#locations = locationsView(kit.signatures);
    this.#mailboxes = openedMailboxesView();
    this.#people = peopleView(kit);
  }

  /**
   * What the origin answers over TLS is the service's, so the identity that signed the Service is
   * taken as the service's.
   */
  async fetch(origin: string): Promise<Service> {
    checkOrigin(origin);
    const bundle = await bundleIn(await fetch(new URL("/", origin), REQUEST), [200]);
    const stagedStore = await this.#intake.stage(bundle, this.#originOf(origin));
    const service = await this.#read(bundle.link, stagedStore);
    if (service.origin !== origin) throw new Error(`the Service at ${origin} names ${service.origin}`);
    await stagedStore.commit();
    return service;
  }

  /**
   * Only a Service signed by a key that the current identity version the store holds lists is
   * honored, so one that a key taken out signs after does not stand in for the service, whatever
   * its `at`.
   */
  async latestOf(signedIdentity: SignedIdentityObject): Promise<Service | undefined> {
    const locations = await view(this.#store, this.#locations);
    const people = await view(this.#store, this.#people);
    const [latest] = await locations.servicesOf(signedIdentity.identity.identifier, people);
    return latest === undefined ? undefined : this.#read(latest.link, this.#store);
  }

  /**
   * A later identity version of the account that takes out the key that signed the request does not
   * change it, so the mailbox stays the account's.
   */
  async pickup(mailbox: Link<EncodedObject>, actor: Actor): Promise<Pickup> {
    const link = await (await view(this.#privateStore, this.#mailboxes)).acknowledgementOf(mailbox);
    if (link === undefined) throw new Error(`the private store lists no mark of opening ${mailbox}`);
    // It says only where to pick up, which a later identity version of the
    // service that does not list the key that signed it does not change.
    const { signedIdentity, object } = await this.#signatures.read(link, this.#store);
    const { request, pickupId } = (await readObject(this.#store, object, mailboxAcknowledgementSchema)).data;
    const { object: requestObject } = (await readObject(this.#store, request.link, this.#signatures.schema)).data;
    const { offer } = (await readObject(this.#store, requestObject.link, mailboxRequestSchema)).data;
    const { size } = (await readObject(this.#store, offer.link, mailboxOfferSchema)).data;
    const service = await this.latestOf(signedIdentity);
    if (service === undefined) throw new Error(`the store holds no Service of ${signedIdentity.identity.identifier}`);
    const target = { mailbox, request: request.link, url: new URL(`/${hex.encode(pickupId)}`, service.origin), size };
    return new ServicePickup(target, actor);
  }

  async #read(link: Link<unknown>, reader: Store | StagedStore): Promise<Service> {
    const people = await view(reader, this.#people);
    const serviceSignature = await this.#signatures.read(link, reader);
    await checkHonors(people, serviceSignature);
    const { signedIdentity, object } = serviceSignature;
    const { identifier } = signedIdentity.identity;
    const { origin, at, offers } = (await readObject(reader, object, serviceSchema)).data;
    checkOrigin(origin);
    const posting = {
      store: this.#store,
      privateStore: this.#privateStore,
      intake: this.#intake,
      origin: this.#originOf(origin),
      signatures: this.#signatures,
      people: this.#people,
    };
    let account: AccountOffer | undefined;
    let mailbox: MailboxOffer | undefined;
    for (const { link: listed } of offers) {
      const bytes: Uint8Array | undefined = await reader.get(listed);
      if (bytes === undefined) throw new AbsentBlob(listed);
      const schema = schemaOf(bytes);
      const url = new URL(`/${listed}`, origin);
      if (account === undefined && schema === accountOfferSchema.link) {
        const offer = decodeObject(bytes, accountOfferSchema);
        if (offer.data.identity.link !== identifier) {
          throw new Error(`the Service of ${identifier} lists an account offer that names another identifier`);
        }
        account = new AccountOffer({ service: signedIdentity, offer: offer.link, url }, posting);
      } else if (mailbox === undefined && schema === mailboxOfferSchema.link) {
        const offer = decodeObject(bytes, mailboxOfferSchema);
        if (offer.data.identity.link !== identifier) {
          throw new Error(`the Service of ${identifier} lists a mailbox offer that names another identifier`);
        }
        mailbox = new MailboxOffer({ service: signedIdentity, offer, url }, posting);
      }
    }
    return { signedIdentity, origin, at, link, account, mailbox };
  }

  #originOf(origin: string): EncodedObject<OriginData> {
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

async function postSigned(
  url: URL,
  signature: Signature,
  blobs: readonly Bytes<unknown>[],
  {
    statuses,
    limit,
    signal,
  }: { readonly statuses: readonly number[]; readonly limit?: number; readonly signal?: AbortSignal | undefined },
): Promise<Bundle> {
  const body = encodeBundle(signature.link, [...signature.blobs, ...blobs]);
  const init = { ...REQUEST, method: "POST", headers: { "content-type": BUNDLE_TYPE }, body, signal: signal ?? null };
  return bundleIn(await fetch(url, init), statuses, limit);
}

async function bundleIn(response: Response, statuses: readonly number[], limit = ANSWER_LIMIT): Promise<Bundle> {
  if (!statuses.includes(response.status)) {
    const reason = await response.text();
    throw new Error(`the service answered ${response.status}${reason === "" ? "" : `: ${reason}`}`);
  }
  const file = await readBody(response.body, limit);
  if (file === undefined) throw new Error(`the service answered more than ${limit} bytes`);
  return decodeBundle(file);
}

export function loadServices(
  store: Store,
  privateStore: PrivateStore,
  { schemes, clock = Date.now }: { readonly schemes: readonly Scheme[]; readonly clock?: () => number },
): Services {
  return new Services(store, privateStore, new Intake(store, privateStore, clock), loadIdentity(schemes));
}
