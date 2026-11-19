import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type IdentityKit,
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
  type Link,
  LinkValue,
  linkOf,
  objectsOf,
  readObject,
  schemaOf,
} from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { indexOver, type PrivateStore, recordsOf, type Store, selectedRecords, type View, view } from "@estoc/store";
import { hex } from "@scure/base";
import { type AcknowledgementsView, acknowledgementsView } from "./acknowledgements.ts";
import { BUNDLE_TYPE, PICKUP, readBody } from "./http.ts";
import { type LocationsView, locationsView } from "./locations.ts";
import type { Mailboxes, OpenMailbox } from "./mailboxes.ts";
import { checkHonors, type PeopleView, peopleView } from "./people.ts";
import {
  accountOfferSchema,
  acknowledgementSchema,
  formOf,
  ID,
  MAILBOX_ID,
  type MailboxOfferData,
  type MailboxTerms,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
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

export interface Accounts {
  /**
   * Keeps `acknowledgement` as the account of `identifier` unless it has one,
   * in one step. Resolves to whether it was kept.
   */
  add(identifier: Link<unknown>, acknowledgement: Link<unknown>): Promise<boolean>;
  has(identifier: Link<unknown>): Promise<boolean>;
}

export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<unknown>, Link<unknown>>();

  async add(identifier: Link<unknown>, acknowledgement: Link<unknown>): Promise<boolean> {
    if (this.#accounts.has(identifier)) return false;
    this.#accounts.set(identifier, acknowledgement);
    return true;
  }

  async has(identifier: Link<unknown>): Promise<boolean> {
    return this.#accounts.has(identifier);
  }
}

export interface ServiceOptions {
  /** Set here rather than read from a request, whose host is the requester's to choose. */
  readonly origin: string;
  readonly store: Store;
  /**
   * The service answers by the acknowledgements recorded here, so one that came to the store
   * another way opens nothing.
   */
  readonly privateStore: PrivateStore;
  readonly accounts: Accounts;
  readonly mailboxes: Mailboxes;
  /**
   * A mailbox opens on the terms of the offer that the latest Service lists, which another start on
   * the same store may have signed, and keeps them.
   */
  readonly terms: MailboxTerms;
  readonly schemes: readonly Scheme[];
  readonly clock?: () => number;
}

class MailboxService {
  readonly #signer: Signer;
  readonly #signedIdentity: SignedIdentityObject;
  readonly #identifier: Link<unknown>;
  readonly #locations: LocationsView;
  readonly #people: PeopleView;
  readonly #acknowledgements: AcknowledgementsView;
  readonly #recordedSignatures: RecordedSignaturesView;
  readonly #signatures: Signatures;
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #accounts: Accounts;
  readonly #mailboxes: Mailboxes;
  readonly #clock: () => number;

  constructor(
    signer: Signer,
    signedIdentity: SignedIdentityObject,
    identifier: Link<unknown>,
    kit: IdentityKit,
    people: PeopleView,
    {
      store,
      privateStore,
      accounts,
      mailboxes,
      clock,
    }: Required<Pick<ServiceOptions, "store" | "privateStore" | "accounts" | "mailboxes" | "clock">>,
  ) {
    this.#signer = signer;
    this.#signedIdentity = signedIdentity;
    this.#identifier = identifier;
    this.#locations = locationsView(kit.signatures);
    this.#people = people;
    this.#acknowledgements = acknowledgementsView(kit.signatures);
    this.#recordedSignatures = recordedSignaturesView(kit.signatures);
    this.#signatures = kit.signatures;
    this.#store = store;
    this.#privateStore = privateStore;
    this.#accounts = accounts;
    this.#mailboxes = mailboxes;
    this.#clock = clock;
  }

  /** It answers any origin, since no request carries credentials. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const locations = await view(this.#store, this.#locations);
    const people = await view(this.#store, this.#people);
    const [latest, ...earlier] = await locations.servicesOf(this.#identifier, people);
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
    if (await this.#serviceListsOffer(latest, id))
      return answerTo(request, "POST", () => this.#acceptOffer(request, id));
    for (const link of earlier) if (await this.#serviceListsOffer(link, id)) return answer(410);
    return answer(404);
  }

  async #serviceListsOffer(link: Link<unknown>, id: string): Promise<boolean> {
    const { object } = await this.#signatures.read(link, this.#store);
    const { offers } = (await readObject(this.#store, object, serviceSchema)).data;
    // The store's own signatures say which offer each is over, and are read
    // for that alone.
    for (const { link } of offers) {
      const signature = await readObject(this.#store, link, this.#signatures.schema);
      if (signature.data.object.link === id) return true;
    }
    return false;
  }

  async #acceptOffer(request: Request, id: string): Promise<Response> {
    const offer = id as Link<EncodedObject>;
    const bytes = await this.#store.get(offer);
    if (bytes === undefined) throw new Error(`the store does not hold ${offer}`);
    if (schemaOf(bytes) === accountOfferSchema.link) return this.#openAccount(request, offer);
    return this.#openMailbox(request, await readObject(this.#store, offer, mailboxOfferSchema));
  }

  /**
   * The signature is verified against the identity versions the service holds once the whole body
   * has come in, however long the sender took to send it. So an agent its root removed is refused
   * even when they have an account, and even for an acceptance that was acknowledged before.
   */
  async #openAccount(request: Request, offer: Link<EncodedObject>): Promise<Response> {
    const file = await readBody(request.body, REQUEST_LIMIT);
    if (file === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const people = await view(this.#store, this.#people);
    let bundle: Bundle;
    let acceptance: Signature;
    try {
      bundle = decodeBundle(file);
      acceptance = await this.#signatures.read(bundle.link, bundle);
      await checkHonors(people, acceptance);
      if (acceptance.object !== offer) throw new Error(`the acceptance signs ${acceptance.object}, not the offer`);
      if (people.personOf(this.#signedIdentity).hasSigned(acceptance))
        throw new Error("a service opens no account for itself");
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const acknowledgements = await view(this.#privateStore, this.#acknowledgements);
    const heldAcknowledgement = await acknowledgements.acknowledgementOf(acceptance.link);
    const acknowledgement =
      heldAcknowledgement === undefined
        ? (
            await this.#acknowledge(
              encodeObject(acknowledgementSchema, { acceptance: new LinkValue(acceptance.link), at }),
              people,
              bundle,
              acceptance.signedIdentity,
            )
          ).link
        : await this.#renew(heldAcknowledgement, people);
    const isNewAccount = await this.#accounts.add(acceptance.signedIdentity.identity.identifier, acknowledgement);
    return this.#answerWith(acknowledgement, isNewAccount ? 201 : 200);
  }

  async #openMailbox(request: Request, offer: EncodedObject<MailboxOfferData>): Promise<Response> {
    const file = await readBody(request.body, REQUEST_LIMIT);
    if (file === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const people = await view(this.#store, this.#people);
    let bundle: Bundle;
    let signature: Signature;
    try {
      bundle = decodeBundle(file);
      signature = await this.#signatures.read(bundle.link, bundle);
      await checkHonors(people, signature);
      const { data } = await readObject(bundle, signature.object, mailboxRequestSchema);
      if (data.offer.link !== offer.link) throw new Error(`the request asks for ${data.offer.link}, not the offer`);
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const { identifier } = signature.signedIdentity.identity;
    if (!(await this.#accounts.has(identifier))) return answer(403, `${identifier} has no account here`);
    const existingMailbox = await this.#mailboxes.mailboxOpenedBy(signature.link);
    if (existingMailbox !== undefined)
      return this.#answerWith(await this.#renew(existingMailbox.acknowledgement, people), 200);
    const [sendId, pickupId] = [newId(), newId()];
    const acknowledgement = await this.#acknowledge(
      encodeObject(mailboxAcknowledgementSchema, {
        request: new LinkValue(signature.link),
        at,
        sendId: hex.decode(sendId),
        pickupId: hex.decode(pickupId),
      }),
      people,
      bundle,
      signature.signedIdentity,
      [...mailboxRequestSchema.blobs],
    );
    const { identity: _, ...terms } = offer.data;
    const mailbox = {
      request: signature.link,
      acknowledgement: acknowledgement.link,
      identifier,
      sendId,
      pickupId,
      terms,
    };
    // Requests of one mailbox at once can each sign an acknowledgement, and
    // each is answered with the one that opened it.
    const keptMailbox = await this.#mailboxes.open(mailbox);
    if (keptMailbox.acknowledgement === acknowledgement.link) return this.#answerWith(acknowledgement.link, 201);
    return this.#answerWith(await this.#renew(keptMailbox.acknowledgement, people), 200);
  }

  async #acknowledge(
    acknowledgement: EncodedObject,
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
    await this.#write(signature, [...own, ...bundle.blobs()]);
    return signature;
  }

  async #renew(link: Link<unknown>, people: People): Promise<Link<unknown>> {
    const signature = await this.#signatures.read(link, this.#store);
    if (await people.honors(signature)) return link;
    const recordedSignatures = await view(this.#privateStore, this.#recordedSignatures);
    for (const recordedLink of await recordedSignatures.signaturesOver(signature.object)) {
      if (recordedLink === link) continue;
      const recordedSignature = await this.#signatures.read(recordedLink, this.#store);
      if (await people.honors(recordedSignature)) return recordedLink;
    }
    const renewedSignature = await this.#sign({ link: signature.object }, people);
    await this.#write(renewedSignature);
    return renewedSignature.link;
  }

  async #write(signature: Signature, blobs: readonly Bytes<unknown>[] = []): Promise<void> {
    await writeSigned(signature, blobs, this.#clock(), { store: this.#store, privateStore: this.#privateStore });
  }

  async #sign(object: { readonly link: Link<unknown> }, people: People): Promise<Signature> {
    return this.#signatures.actor(this.#signer, await people.current(this.#signedIdentity)).sign(object);
  }

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

  async #pickUp(request: Request, mailbox: OpenMailbox): Promise<Response> {
    const file = await readBody(request.body, PICKUP_LIMIT);
    if (file === undefined) return answer(413, `a pickup request holds at most ${PICKUP_LIMIT} bytes`);
    const people = await view(this.#store, this.#people);
    let signature: Signature;
    let receipts: Link<Uint8Array>[];
    try {
      const bundle = decodeBundle(file);
      signature = await this.#signatures.read(bundle.link, bundle);
      const { data } = await readObject(bundle, signature.object, pickupRequestSchema);
      if (data.mailbox.link !== mailbox.request)
        throw new Error(`the request picks up at ${data.mailbox.link}, not at this mailbox`);
      receipts = data.receipts.map(({ link }) => link);
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    const { signedIdentity, key } = signature;
    if (signedIdentity.identity.identifier !== mailbox.identifier)
      return answer(403, "the request is signed for another identifier than the mailbox's account");
    if (!(await people.honors(signature)))
      return answer(
        403,
        `the signature by ${key.link} is not honored by the identity versions of ${mailbox.identifier}`,
      );
    const at = this.#clock();
    await this.#mailboxes.drop(mailbox.sendId, receipts);
    const ciphertexts = await batchOf(this.#mailboxes.queue(mailbox.sendId, at - mailbox.terms.retention));
    const pickupAnswer = encodeObject(pickupAnswerSchema, {
      ciphertexts: ciphertexts.map((bytes) => new LinkValue<Uint8Array>(linkOf(bytes))),
    });
    return bundleAnswer(200, encodeBundle(pickupAnswer.link, [pickupAnswer.bytes, ...ciphertexts]));
  }

  async #answerWith(link: Link<unknown>, status: number): Promise<Response> {
    return bundleAnswer(status, encodeBundle(link, (await this.#store.closure(link)).values()));
  }
}

export type { MailboxService };

const newId = () => hex.encode(crypto.getRandomValues(new Uint8Array(16)));

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  // A browser asks before it posts a bundle, or a ciphertext, to another origin.
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

function bundleAnswer(status: number, file: Uint8Array): Response {
  return new Response(file, { status, headers: { "access-control-allow-origin": "*", "content-type": BUNDLE_TYPE } });
}

export async function loadMailboxService(
  signer: Signer,
  { origin, schemes, terms, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store, privateStore } = options;
  const kit = loadIdentity(schemes);
  const { keys, signatures, publish } = kit;
  const identifier: Link<unknown> = keys.encode(signer.key).link;
  const identity = new LinkValue(identifier);
  const offers = [
    encodeObject(accountOfferSchema, { identity }),
    encodeObject(mailboxOfferSchema, { identity, ...terms }),
  ];

  const seenPeople = peopleView(kit.identityVersions);
  const people = await view(store, seenPeople);
  const locations = await view(store, locationsView(signatures));
  const at = clock();
  const [signedBefore] = await locations.servicesOf(identifier, noIdentityVersions);
  const signedIdentity =
    signedBefore === undefined
      ? await publish(signer, { at })
      : await people.current((await signatures.read(signedBefore, store)).signedIdentity);
  const actor = signatures.actor(signer, signedIdentity);
  const serviceSignatures = await Promise.all(
    (await locations.servicesOf(identifier, people)).map((link) => signatures.read(link, store)),
  );
  const services = await Promise.all(serviceSignatures.map(({ object }) => readObject(store, object, serviceSchema)));
  const [previous] = services;
  const signedOffers: (readonly [EncodedObject, Signature])[] = [];
  for (const offer of offers) {
    const signature =
      (await signatureListedIn(services, offer.link, signatures, store, people)) ?? (await actor.sign(offer));
    signedOffers.push([offer, signature]);
  }
  const next: ServiceData = {
    origin,
    at,
    offers: signedOffers.map(([, signature]) => new LinkValue(signature.link)),
  };
  if (previous === undefined || formOf(previous.data) !== formOf(next)) {
    const object = encodeObject(serviceSchema, next);
    const blobs = [
      object.bytes,
      ...serviceSchema.blobs,
      ...signedOffers.flatMap(([offer, signature]) => [...signature.blobs, offer.bytes, ...offer.schema.blobs]),
    ];
    await writeSigned(await actor.sign(object), blobs, at, { store, privateStore });
  }
  return new MailboxService(signer, actor.signedIdentity, identifier, kit, seenPeople, {
    ...options,
    clock,
  });
}

async function writeSigned(
  signature: Signature,
  blobs: readonly Bytes<unknown>[],
  at: number,
  { store, privateStore }: Pick<ServiceOptions, "store" | "privateStore">,
): Promise<void> {
  await store.write({ roots: [signature.link], blobs: [...signature.blobs, ...blobs] });
  await privateStore.write(recordsOf([signature.link], at));
}

const recordedSignatureSchema = schema("Recorded signature", { object: link(), signature: link() });

type RecordedSignaturesView = View<
  DataOf<typeof recordedSignatureSchema>,
  readonly ["object", "signature"],
  { signaturesOver(object: Link<unknown>): Promise<Link<unknown>[]> }
>;

/** A signature that the store holds may have no record, as when a write stopped between the two. */
function recordedSignaturesView(signatures: Signatures): RecordedSignaturesView {
  return {
    index: indexOver(selectedRecords(objectsOf(signatures.schema)), recordedSignatureSchema, ({ link, data }) => [
      { object: new LinkValue(data.object.link), signature: new LinkValue(link) },
    ]).orderedBy("object", "signature"),
    read: (rows) => ({
      async signaturesOver(object) {
        const links: Link<unknown>[] = [];
        for await (const { data } of rows.range([new LinkValue(object)])) links.push(data.signature.link);
        return links;
      },
    }),
  };
}

async function signatureListedIn(
  services: readonly EncodedObject<ServiceData>[],
  offer: Link<unknown>,
  signatures: Signatures,
  store: Store,
  people: People,
): Promise<Signature | undefined> {
  for (const { data } of services) {
    for (const { link } of data.offers) {
      const signature = await signatures.read(link, store);
      await checkHonors(people, signature);
      if (signature.object === offer) return signature;
    }
  }
  return undefined;
}
