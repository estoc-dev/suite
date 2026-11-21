import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type IdentityKit,
  loadIdentity,
  type Scheme,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
} from "@estoc/identity";
import type { Keyring } from "@estoc/keyring";
import {
  type Bytes,
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
import { type People, type PeopleView, peopleView } from "@estoc/people";
import { type Marks, type Store, view } from "@estoc/store";
import { hex } from "@scure/base";
import type { Accounts } from "./accounts.ts";
import { type AcknowledgementsView, acknowledgementsView } from "./acknowledgements.ts";
import { BUNDLE_TYPE, PICKUP, readBody } from "./http.ts";
import { type LocationsView, locationsView } from "./locations.ts";
import type { Mailboxes, OpenMailbox } from "./mailboxes.ts";
import { loadNotary, type Notary } from "./notary.ts";
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

// Anyone can post to a service, and a request is a few small blobs: a
// signature, its signed identity, and what it signs.
const REQUEST_LIMIT = 64 * 1024;
// A pickup request also lists, as receipts, what the receiver is done with of
// the answer before: PICKUP.count ciphertexts at most, each by a link of under
// 128 bytes.
const PICKUP_LIMIT = REQUEST_LIMIT + PICKUP.count * 128;

export interface ServiceOptions {
  /** Set here rather than read from a request, whose host is the requester's to choose. */
  readonly origin: string;
  readonly store: Store;
  /**
   * The service answers by the acknowledgements it records through this, so one that only came to
   * the store opens nothing.
   */
  readonly marks: Marks;
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

type SignedRequest = {
  readonly signature: Signature;
  readonly bundle: Bundle;
  readonly people: People;
  readonly receivedAt: number;
};

class MailboxService {
  readonly #notary: Notary;
  readonly #locations: LocationsView;
  readonly #people: PeopleView;
  readonly #acknowledgements: AcknowledgementsView;
  readonly #signatures: Signatures;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #mailboxes: Mailboxes;
  readonly #clock: () => number;

  constructor(
    notary: Notary,
    kit: IdentityKit,
    people: PeopleView,
    { store, accounts, mailboxes, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "mailboxes" | "clock">>,
  ) {
    this.#notary = notary;
    this.#locations = locationsView(kit.signatures);
    this.#people = people;
    this.#acknowledgements = acknowledgementsView(kit.signatures);
    this.#signatures = kit.signatures;
    this.#store = store;
    this.#accounts = accounts;
    this.#mailboxes = mailboxes;
    this.#clock = clock;
  }

  get identifier(): Link<unknown> {
    return this.#notary.identifier;
  }

  /** It answers any origin, since no request carries credentials. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const locations = await view(this.#store, this.#locations);
    const people = await view(this.#store, this.#people);
    const [latest, ...earlier] = await locations.servicesOf(this.#notary.identifier, people);
    if (latest === undefined) throw new Error("the store holds no Service of the service's");
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(latest.link, 200));
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
    for (const service of earlier) if (await this.#serviceListsOffer(service, id)) return answer(410);
    return answer(404);
  }

  async #serviceListsOffer({ object }: Signature, id: string): Promise<boolean> {
    const { offers } = (await readObject(this.#store, object, serviceSchema)).data;
    return offers.some(({ link }) => link === id);
  }

  async #acceptOffer(request: Request, id: string): Promise<Response> {
    const offer = id as Link<EncodedObject>;
    const bytes = await this.#store.get(offer);
    if (bytes === undefined) throw new Error(`the store does not hold ${offer}`);
    if (schemaOf(bytes) === accountOfferSchema.link) return this.#openAccount(request, offer);
    return this.#openMailbox(request, await readObject(this.#store, offer, mailboxOfferSchema));
  }

  /**
   * Whether the signature is honored is asked of the identity versions the service holds once the
   * whole body has come in, however long the sender took to send it. So an agent its root removed
   * is refused even when they have an account, and even for a request that was acknowledged before.
   */
  async #readSigned(request: Request, limit: number): Promise<SignedRequest | Response> {
    const file = await readBody(request.body, limit);
    if (file === undefined) return answer(413, `a request holds at most ${limit} bytes`);
    const receivedAt = this.#clock();
    const people = await view(this.#store, this.#people);
    let bundle: Bundle;
    let signature: Signature;
    try {
      bundle = decodeBundle(file);
      signature = await this.#signatures.read(bundle.link, bundle);
    } catch (error) {
      return answer(400, reasonOf(error));
    }
    if (!(await people.honors(signature))) {
      const { key, signedIdentity } = signature;
      return answer(
        403,
        `the signature by ${key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
      );
    }
    return { signature, bundle, people, receivedAt };
  }

  async #readSignedObject<F extends ValueMap>(
    request: Request,
    limit: number,
    schema: Schema<F>,
  ): Promise<(SignedRequest & { readonly object: EncodedObject<F> }) | Response> {
    const signedRequest = await this.#readSigned(request, limit);
    if (signedRequest instanceof Response) return signedRequest;
    const { signature, bundle } = signedRequest;
    try {
      return { ...signedRequest, object: await readObject(bundle, signature.object, schema) };
    } catch (error) {
      return answer(400, reasonOf(error));
    }
  }

  async #openAccount(request: Request, offer: Link<EncodedObject>): Promise<Response> {
    const signedRequest = await this.#readSigned(request, REQUEST_LIMIT);
    if (signedRequest instanceof Response) return signedRequest;
    const { signature: acceptance, bundle, people, receivedAt: at } = signedRequest;
    if (acceptance.object !== offer) return answer(400, `the acceptance signs ${acceptance.object}, not the offer`);
    if (acceptance.signedIdentity.identity.identifier === this.#notary.identifier)
      return answer(400, "a service opens no account for itself");
    const acknowledgements = await view(this.#store, this.#acknowledgements);
    const heldAcknowledgement = await acknowledgements.acknowledgementOf(acceptance.link);
    const acknowledgement =
      heldAcknowledgement === undefined
        ? (
            await this.#acknowledge(
              encodeObject(acknowledgementSchema, { acceptance: new LinkValue(acceptance.link), at }),
              bundle,
              acceptance.signedIdentity,
            )
          ).link
        : await this.#notary.renew(heldAcknowledgement, people);
    const isNewAccount = await this.#accounts.add(acceptance.signedIdentity.identity.identifier, acknowledgement);
    return this.#answerWith(acknowledgement, isNewAccount ? 201 : 200);
  }

  async #openMailbox(request: Request, offer: EncodedObject<MailboxOfferData>): Promise<Response> {
    const signedRequest = await this.#readSignedObject(request, REQUEST_LIMIT, mailboxRequestSchema);
    if (signedRequest instanceof Response) return signedRequest;
    const { signature, object, bundle, people, receivedAt: at } = signedRequest;
    if (object.data.offer.link !== offer.link)
      return answer(400, `the request asks for ${object.data.offer.link}, not the offer`);
    const { identifier } = signature.signedIdentity.identity;
    if (!(await this.#accounts.has(identifier))) return answer(403, `${identifier} has no account here`);
    const existingMailbox = await this.#mailboxes.mailboxOpenedBy(signature.link);
    if (existingMailbox !== undefined)
      return this.#answerWith(await this.#notary.renew(existingMailbox.acknowledgement, people), 200);
    const [sendId, pickupId] = [newId(), newId()];
    const acknowledgement = await this.#acknowledge(
      encodeObject(mailboxAcknowledgementSchema, {
        request: new LinkValue(signature.link),
        at,
        sendId: hex.decode(sendId),
        pickupId: hex.decode(pickupId),
      }),
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
    return this.#answerWith(await this.#notary.renew(keptMailbox.acknowledgement, people), 200);
  }

  async #acknowledge(
    acknowledgement: EncodedObject,
    bundle: Bundle,
    signedIdentity: SignedIdentityObject,
    blobs: readonly Bytes<unknown>[] = [],
  ): Promise<Signature> {
    // Reading what is acknowledged takes none of the schemas in its signed
    // identity's closure, so the bundle need not hold them, and the store
    // takes a blob in only with its whole closure.
    return this.#notary.sign(acknowledgement, [...signedIdentity.blobs, ...blobs, ...bundle.blobs()]);
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
    const signedRequest = await this.#readSignedObject(request, PICKUP_LIMIT, pickupRequestSchema);
    if (signedRequest instanceof Response) return signedRequest;
    const { signature, object } = signedRequest;
    if (object.data.mailbox.link !== mailbox.request)
      return answer(400, `the request picks up at ${object.data.mailbox.link}, not at this mailbox`);
    if (signature.signedIdentity.identity.identifier !== mailbox.identifier)
      return answer(403, "the request is signed for another identifier than the mailbox's account");
    const receipts = object.data.receipts.map(({ link }) => link);
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
  keyring: Pick<Keyring, "signerFor">,
  { origin, schemes, terms, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store, marks } = options;
  const kit = loadIdentity(schemes);
  const seenPeople = peopleView(kit);
  const notary = await loadNotary(keyring, { kit, store, marks, people: seenPeople, clock });
  const identity = new LinkValue(notary.identifier);
  const offers = [
    encodeObject(accountOfferSchema, { identity }),
    encodeObject(mailboxOfferSchema, { identity, ...terms }),
  ];

  // A store only gains blobs, and holds each Service with the identity version its signature
  // carries, so people read after the locations have seen that of every Service that the locations
  // give.
  const locations = await view(store, locationsView(kit.signatures));
  const people = await view(store, seenPeople);
  const at = clock();
  const [latest] = await locations.servicesOf(notary.identifier, people);
  const previous = latest === undefined ? undefined : (await readObject(store, latest.object, serviceSchema)).data;
  const next: ServiceData = { origin, at, offers: offers.map(({ link }) => new LinkValue(link)) };
  if (previous === undefined || formOf(previous) !== formOf(next))
    await notary.sign(
      encodeObject(serviceSchema, next),
      offers.flatMap(({ bytes, schema }) => [bytes, ...schema.blobs]),
    );
  return new MailboxService(notary, kit, seenPeople, { ...options, clock });
}
