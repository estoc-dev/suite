import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type IdentityKit,
  type KeyObject,
  loadIdentity,
  noIdentityVersions,
  type People,
  type Scheme,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
  type Signer,
} from "@estoc/identity";
import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type Json,
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
import { type AcknowledgementsView, acknowledgementsView } from "./acknowledgements.ts";
import { PICKUP, readBody, ZIP } from "./http.ts";
import { type LocationsView, locationsView } from "./locations.ts";
import type { Mailboxes, OpenMailbox } from "./mailboxes.ts";
import { type PeopleView, peopleView } from "./people.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  formOf,
  ID,
  MAILBOX_ID,
  type MailboxAcknowledgementData,
  type MailboxOfferData,
  type MailboxRequestData,
  type MailboxTerms,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
  type PickupAnswerData,
  type PickupRequestData,
  pickupAnswerSchema,
  pickupRequestSchema,
  type ServiceData,
  serviceSchema,
} from "./schemas.ts";

export { type Mailboxes, MemoryMailboxes, type OpenMailbox } from "./mailboxes.ts";

// Anyone can post to a service, and a request is a few small blobs: a
// signature, its signed identity, and what it signs.
const REQUEST_LIMIT = 64 * 1024;
// A pickup request also lists, as receipts, what the receiver is done with of
// the answer before: PICKUP.count ciphertexts at most, each by a link of under
// 128 bytes.
const PICKUP_LIMIT = REQUEST_LIMIT + PICKUP.count * 128;

type Schemas = {
  readonly service: Schema<Json, ServiceData>;
  readonly accountOffer: Schema<Json, AccountOfferData>;
  readonly mailboxOffer: Schema<Json, MailboxOfferData>;
  readonly acknowledgement: Schema<Json, AcknowledgementData>;
  readonly mailboxRequest: Schema<Json, MailboxRequestData>;
  readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
  readonly pickupRequest: Schema<Json, PickupRequestData>;
  readonly pickupAnswer: Schema<Json, PickupAnswerData>;
};

/**
 * The accounts of a service, one for each root of an identity, as the link
 * of the service's signature over the acknowledgement of the acceptance that
 * opened it.
 */
export interface Accounts {
  /**
   * Keeps `acknowledgement` as `root`'s account unless `root` has one, in one
   * step. Resolves to whether it was kept.
   */
  add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean>;
  has(root: Link<KeyObject>): Promise<boolean>;
}

/** Keeps accounts in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<KeyObject>, Link<Signature>>();

  async add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean> {
    if (this.#accounts.has(root)) return false;
    this.#accounts.set(root, acknowledgement);
    return true;
  }

  async has(root: Link<KeyObject>): Promise<boolean> {
    return this.#accounts.has(root);
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
   * Where the service writes what it signs as records, with their closure:
   * its Services, which say what ids it gave out, and the acknowledgements.
   */
  readonly store: Store;
  readonly accounts: Accounts;
  readonly mailboxes: Mailboxes;
  /**
   * The terms that the service signs into its offer of mailboxes.
   *
   * - Other terms are another offer, which a new Service lists.
   * - A mailbox opens on the terms of the offer that the latest Service lists,
   *   which another start on the same store may have signed, and keeps them.
   */
  readonly terms: MailboxTerms;
  /** The validator that the schemas are compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The schemes of the keys the service reads, its own and those of whoever signs to it. */
  readonly schemes: readonly Scheme[];
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * A mailbox service, as a handler of HTTP requests.
 *
 * - `GET /` answers the service's signed Service.
 * - A `POST` to the id that the Service lists for the offer of an account
 *   opens one for whoever signed the offer.
 * - A `POST` to the id of the offer of mailboxes opens a mailbox under that
 *   account.
 * - A `POST` to a mailbox's send id leaves a ciphertext there, and to its
 *   pickup id picks up what waits.
 */
class MailboxService {
  readonly #signer: Signer;
  readonly #signedIdentity: SignedIdentityObject;
  readonly #root: Link<KeyObject>;
  readonly #locations: LocationsView;
  readonly #people: PeopleView;
  readonly #acknowledgements: AcknowledgementsView;
  readonly #signatures: Signatures;
  readonly #schemas: Schemas;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #mailboxes: Mailboxes;
  readonly #clock: () => number;

  constructor(
    signer: Signer,
    signedIdentity: SignedIdentityObject,
    root: Link<KeyObject>,
    kit: IdentityKit,
    schemas: Schemas,
    people: PeopleView,
    { store, accounts, mailboxes, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "mailboxes" | "clock">>,
  ) {
    this.#signer = signer;
    this.#signedIdentity = signedIdentity;
    this.#root = root;
    this.#locations = locationsView(kit.signatures, schemas.service);
    this.#people = people;
    this.#acknowledgements = acknowledgementsView(kit.signatures, schemas.acknowledgement);
    this.#signatures = kit.signatures;
    this.#schemas = schemas;
    this.#store = store;
    this.#accounts = accounts;
    this.#mailboxes = mailboxes;
    this.#clock = clock;
  }

  /**
   * Answers a request by the service's Services that the store holds now.
   * It answers any origin, since no request carries credentials.
   *
   * @throws when the store holds no Service of the service's.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const locations = await view(this.#store, this.#locations);
    const people = await view(this.#store, this.#people);
    const [latest, ...earlier] = await locations.servicesOf(this.#root, people);
    if (latest === undefined) throw new Error("the store holds no Service of the service's");
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(latest, 200));
    const id = pathname.slice(1);
    if (MAILBOX_ID.test(id)) {
      const mailbox = await this.#mailboxes.mailboxNamed(id);
      if (mailbox === undefined) return answer(404);
      return answerTo(request, "POST", () =>
        id === mailbox.sendId ? this.#receive(request, mailbox) : this.#pickUp(request, mailbox),
      );
    }
    if (!ID.test(id)) return answer(404);
    if (await this.#serviceListsOffer(latest, id, people))
      return answerTo(request, "POST", () => this.#acceptOffer(request, id));
    for (const link of earlier) if (await this.#serviceListsOffer(link, id, people)) return answer(410);
    return answer(404);
  }

  async #serviceListsOffer(link: Link<Signature>, id: string, people: People): Promise<boolean> {
    const { object } = await this.#signatures.read(link, this.#store, people);
    const { offers } = (await readObject(this.#store, object, this.#schemas.service)).data;
    return offers.some(({ acceptId }) => acceptId === id);
  }

  /**
   * Takes what is posted to the id of an offer that the latest Service lists.
   * The id is the offer's link, so the offer is read from the store,
   * whichever start of the service signed it.
   *
   * @throws when the store does not hold the offer.
   */
  async #acceptOffer(request: Request, id: string): Promise<Response> {
    const offer = id as Link<EncodedObject<Json>>;
    const bytes = await this.#store.get(offer);
    if (bytes === undefined) throw new Error(`the store does not hold ${offer}`);
    if (schemaOf(bytes, json) === this.#schemas.accountOffer.link) return this.#openAccount(request, offer);
    return this.#openMailbox(request, await readObject(this.#store, offer, this.#schemas.mailboxOffer));
  }

  /**
   * Acknowledges the posted signature over `offer`, and opens an account for
   * the root of its identity unless the root has one.
   *
   * - Either way the answer is an acknowledgement of this acceptance, one that
   *   the store holds or a new one.
   * - The signature is verified against the identity versions the service
   *   holds once the whole body has come in, however long the sender took to
   *   send it. So an agent its root removed is refused even when the root has
   *   an account, and even for an acceptance that was acknowledged before.
   */
  async #openAccount(request: Request, offer: Link<EncodedObject<Json>>): Promise<Response> {
    const zip = await readBody(request.body, REQUEST_LIMIT);
    if (zip === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const people = await view(this.#store, this.#people);
    let bundle: Bundle;
    let acceptance: Signature;
    try {
      bundle = await unpackBundle(zip);
      acceptance = await this.#signatures.read(bundle.link, bundle, people);
      if (acceptance.object !== offer) throw new Error(`the acceptance signs ${acceptance.object}, not the offer`);
      if (people.personOf(this.#signedIdentity).hasSigned(acceptance))
        throw new Error("a service opens no account for itself");
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const acknowledgements = await view(this.#store, this.#acknowledgements);
    const heldAcknowledgement = await acknowledgements.acknowledgementOf(acceptance.link);
    const acknowledgement =
      heldAcknowledgement === undefined
        ? (
            await this.#acknowledge(
              encodeObject(this.#schemas.acknowledgement, { acceptance: { $link: acceptance.link }, at }),
              people,
              bundle,
              acceptance.signedIdentity,
            )
          ).link
        : await this.#renew(heldAcknowledgement, people);
    const isNewAccount = await this.#accounts.add(acceptance.signedIdentity.identity.root.link, acknowledgement);
    return this.#answerWith(acknowledgement, isNewAccount ? 201 : 200);
  }

  /**
   * Opens a mailbox on `offer`'s terms, under the account of the root whose
   * identity signed the posted request for it, unless that request opened one
   * before.
   *
   * - Either way the answer is the acknowledgement of the request.
   * - The signature is verified as an acceptance of the offer of an account
   *   is, and refused when its root has no account.
   */
  async #openMailbox(request: Request, offer: EncodedObject<Json, MailboxOfferData>): Promise<Response> {
    const zip = await readBody(request.body, REQUEST_LIMIT);
    if (zip === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const people = await view(this.#store, this.#people);
    let bundle: Bundle;
    let signature: Signature;
    try {
      bundle = await unpackBundle(zip);
      signature = await this.#signatures.read(bundle.link, bundle, people);
      const { data } = await readObject(bundle, signature.object, this.#schemas.mailboxRequest);
      if (data.offer.$link !== offer.link) throw new Error(`the request asks for ${data.offer.$link}, not the offer`);
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const root = signature.signedIdentity.identity.root.link;
    if (!(await this.#accounts.has(root))) return answer(403, `${root} has no account here`);
    const existingMailbox = await this.#mailboxes.mailboxOpenedBy(signature.link);
    if (existingMailbox !== undefined)
      return this.#answerWith(await this.#renew(existingMailbox.acknowledgement, people), 200);
    const [sendId, pickupId] = [newId(), newId()];
    const acknowledgement = await this.#acknowledge(
      encodeObject(this.#schemas.mailboxAcknowledgement, { request: { $link: signature.link }, at, sendId, pickupId }),
      people,
      bundle,
      signature.signedIdentity,
      this.#schemas.mailboxRequest.blobs,
    );
    const { identity: _, ...terms } = offer.data;
    const mailbox = { request: signature.link, acknowledgement: acknowledgement.link, root, sendId, pickupId, terms };
    // Requests of one mailbox at once can each sign an acknowledgement, and
    // each is answered with the one that opened it.
    const keptMailbox = await this.#mailboxes.open(mailbox);
    if (keptMailbox.acknowledgement === acknowledgement.link) return this.#answerWith(acknowledgement.link, 201);
    return this.#answerWith(await this.#renew(keptMailbox.acknowledgement, people), 200);
  }

  /**
   * Signs `acknowledgement` of what `bundle` holds at its root, and writes it
   * to the store as a record, with `blobs` from the closure of what it
   * acknowledges. From then on the service holds the identity version that
   * signed what it acknowledges.
   */
  async #acknowledge(
    acknowledgement: EncodedObject<Json>,
    people: People,
    bundle: Bundle,
    signedIdentity: SignedIdentityObject,
    blobs: readonly Bytes<unknown>[] = [],
  ): Promise<Signature> {
    const signature = await this.#sign(acknowledgement, people);
    // Reading what is acknowledged takes none of the schemas in its signed
    // identity's closure, so the bundle need not hold them, and the store
    // takes a blob in only with its whole closure.
    const { schema } = acknowledgement;
    const own = [acknowledgement.bytes, ...schema.blobs, ...signedIdentity.blobs, ...blobs];
    await this.#store.write({ records: [signature], blobs: [...own, ...bundle.blobs()] });
    return signature;
  }

  /**
   * The service's signature at `link` over an acknowledgement while `people`
   * honor it. Once a crisis of the service's root cuts it, the service
   * signs the same acknowledgement as its current identity version, and
   * writes that signature to the store as a record.
   */
  async #renew(link: Link<Signature>, people: People): Promise<Link<Signature>> {
    const signature = await this.#signatures.read(link, this.#store, noIdentityVersions);
    if (await people.honors(signature)) return link;
    const renewedSignature = await this.#sign({ link: signature.object }, people);
    await this.#store.write({ records: [renewedSignature] });
    return renewedSignature.link;
  }

  /**
   * Signs `object` as the current identity version of the service's root by
   * `people`, which a crisis that the store comes to hold changes while the
   * service runs.
   */
  async #sign(object: { readonly link: Link<unknown> }, people: People): Promise<Signature> {
    return this.#signatures.actor(this.#signer, await people.current(this.#signedIdentity)).sign(object);
  }

  /**
   * Keeps the ciphertext posted to a mailbox's send id waiting there,
   * unless it is over its size or would take what waits over its quota.
   * Anyone can post there, as to any HTTP mailbox.
   */
  async #receive(request: Request, { sendId, terms }: OpenMailbox): Promise<Response> {
    const ciphertext = await readBody(request.body, terms.size);
    if (ciphertext === undefined) return answer(413, `a message to this mailbox holds at most ${terms.size} bytes`);
    const at = this.#clock();
    const waits = await this.#mailboxes.put(sendId, ciphertext, {
      at,
      since: at - terms.retention,
      quota: terms.quota,
    });
    return waits ? answer(204) : answer(429, `this mailbox holds at most ${terms.quota} bytes that wait`);
  }

  /**
   * Lets the ciphertexts that the posted pickup request has receipts for
   * wait no more, and answers with what waits then.
   *
   * The request is verified as signed for the root of the mailbox's account,
   * and as honored by the identity versions the store holds. When it is not,
   * it is refused with 403, though it reads.
   */
  async #pickUp(request: Request, mailbox: OpenMailbox): Promise<Response> {
    const zip = await readBody(request.body, PICKUP_LIMIT);
    if (zip === undefined) return answer(413, `a pickup request holds at most ${PICKUP_LIMIT} bytes`);
    const people = await view(this.#store, this.#people);
    let signature: Signature;
    let receipts: Link<Uint8Array>[];
    try {
      const bundle = await unpackBundle(zip);
      signature = await this.#signatures.read(bundle.link, bundle, noIdentityVersions);
      const { data } = await readObject(bundle, signature.object, this.#schemas.pickupRequest);
      if (data.mailbox.$link !== mailbox.request)
        throw new Error(`the request picks up at ${data.mailbox.$link}, not at this mailbox`);
      receipts = data.receipts.map(({ $link }) => $link);
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const { signedIdentity, key } = signature;
    if (signedIdentity.identity.root.link !== mailbox.root)
      return answer(403, "the request is signed for another root than the mailbox's account");
    if (!(await people.honors(signature)))
      return answer(403, `the signature by ${key.link} is not honored by the identity versions of ${mailbox.root}`);
    const at = this.#clock();
    await this.#mailboxes.drop(mailbox.sendId, receipts);
    const ciphertexts = await batchOf(this.#mailboxes.queue(mailbox.sendId, at - mailbox.terms.retention));
    const pickupAnswer = encodeObject(this.#schemas.pickupAnswer, {
      ciphertexts: ciphertexts.map((bytes) => ({ $link: linkOf(bytes) })),
    });
    return bundleAnswer(200, await packBundle(pickupAnswer, ciphertexts));
  }

  /**
   * Answers with the bundle of one of the service's signatures and its
   * closure in the store.
   *
   * @throws when the store does not hold `link` or a blob of its closure.
   */
  async #answerWith(link: Link<Signature>, status: number): Promise<Response> {
    const closure = await this.#store.closure(link);
    const bytes = closure.get(link);
    if (bytes === undefined) throw new Error(`the store does not hold ${link}`);
    const blobs = [...closure].filter(([linked]) => linked !== link).map(([, blob]) => blob);
    return bundleAnswer(status, await packBundle({ bytes }, blobs));
  }
}

export type { MailboxService };

const newId = () => hex.encode(crypto.getRandomValues(new Uint8Array(16)));

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** As much of `queue` as one pickup answers with, from the earliest. */
async function batchOf(queue: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const batch: Uint8Array[] = [];
  let bytes = 0;
  for await (const ciphertext of queue) {
    if (batch.length === PICKUP.count || (batch.length > 0 && bytes + ciphertext.length > PICKUP.bytes)) break;
    batch.push(ciphertext);
    bytes += ciphertext.length;
  }
  return batch;
}

function answerTo(request: Request, method: string, handle: () => Promise<Response>): Promise<Response> | Response {
  // A browser asks before it posts a zip, or a ciphertext, to another origin.
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
 * Makes the service of `signer`'s identity at `origin`.
 *
 * - The store holds the Services the service signed before, and the latest
 *   of them that is honored says where it was and what it offered there.
 * - When the service says the same now, that Service stays the latest, and
 *   else the service signs a new one, as it does when none is honored once
 *   its root signed a crisis.
 * - Either way the latest lists the offer of an account and the offer of
 *   mailboxes on `terms`, each under its link, with the service's signature
 *   over it from the latest Service that lists it.
 * - The service signs as the current identity version of its root, by the
 *   identity versions the store holds, and publishes its identity only when
 *   the store holds no Service of it.
 *
 * @throws when `origin` is not an origin: a scheme, a host and a port alone.
 */
export async function loadMailboxService(
  signer: Signer,
  { origin, validator, schemes, terms, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store } = options;
  const kit = await loadIdentity(validator, schemes);
  const { keys, signatures, publish } = kit;
  const compile = <F extends Fields<Json>>(schema: JsonSchema): Promise<Schema<Json, F>> =>
    encodeSchema(schema, validator);
  const schemas: Schemas = {
    service: await compile(serviceSchema),
    accountOffer: await compile(accountOfferSchema),
    mailboxOffer: await compile(mailboxOfferSchema),
    acknowledgement: await compile(acknowledgementSchema),
    mailboxRequest: await compile(mailboxRequestSchema),
    mailboxAcknowledgement: await compile(mailboxAcknowledgementSchema),
    pickupRequest: await compile(pickupRequestSchema),
    pickupAnswer: await compile(pickupAnswerSchema),
  };
  const identity = { $link: keys.encode(signer.key).link };
  const offers = [
    encodeObject(schemas.accountOffer, { identity }),
    encodeObject(schemas.mailboxOffer, { identity, ...terms }),
  ];

  const seenPeople = peopleView(kit.identityVersions);
  const people = await view(store, seenPeople);
  const locations = await view(store, locationsView(signatures, schemas.service));
  const at = clock();
  const [signedBefore] = await locations.servicesOf(identity.$link, noIdentityVersions);
  const signedIdentity =
    signedBefore === undefined
      ? await publish(signer, { at })
      : await people.current((await signatures.read(signedBefore, store, noIdentityVersions)).signedIdentity);
  const actor = signatures.actor(signer, signedIdentity);
  const serviceSignatures = await Promise.all(
    (await locations.servicesOf(identity.$link, people)).map((link) => signatures.read(link, store, people)),
  );
  const services = await Promise.all(serviceSignatures.map(({ object }) => readObject(store, object, schemas.service)));
  const [previous] = services;
  const signedOffers: (readonly [EncodedObject<Json>, Signature])[] = [];
  for (const offer of offers) {
    const signature =
      (await signatureListedIn(services, offer.link, signatures, store, people)) ?? (await actor.sign(offer));
    signedOffers.push([offer, signature]);
  }
  const next: ServiceData = {
    origin,
    at,
    offers: signedOffers.map(([offer, signature]) => ({ offer: { $link: signature.link }, acceptId: offer.link })),
  };
  if (previous === undefined || formOf(previous.data) !== formOf(next)) {
    const object = encodeObject(schemas.service, next);
    const blobs = [
      object.bytes,
      ...schemas.service.blobs,
      ...signedOffers.flatMap(([offer, signature]) => [signature.bytes, offer.bytes, ...offer.schema.blobs]),
      ...signatures.schema.blobs,
      ...actor.signedIdentity.blobs,
    ];
    await store.write({ records: [await actor.sign(object)], blobs });
  }
  return new MailboxService(signer, actor.signedIdentity, identity.$link, kit, schemas, seenPeople, {
    ...options,
    clock,
  });
}

/** The service's signature over `offer` from the first of `services` that lists it, or `undefined` when none does. */
async function signatureListedIn(
  services: readonly EncodedObject<Json, ServiceData>[],
  offer: Link<unknown>,
  signatures: Signatures,
  store: Store,
  people: People,
): Promise<Signature | undefined> {
  for (const { data } of services) {
    for (const { offer: listedOffer } of data.offers) {
      const signature = await signatures.read(listedOffer.$link, store, people);
      if (signature.object === offer) return signature;
    }
  }
  return undefined;
}
