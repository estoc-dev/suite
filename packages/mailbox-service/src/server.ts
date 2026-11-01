import { type Bundle, packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  type IdentityKit,
  type KeyObject,
  loadIdentity,
  type People,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
  type Signer,
} from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchemaValidator,
  type Link,
  readObject,
  type Schema,
} from "@estoc/object";
import { type Store, view } from "@estoc/store";
import { type Acknowledgements, acknowledgementOf, acknowledgements } from "./acknowledgements.ts";
import { readBody, ZIP } from "./http.ts";
import { type Locations, locations, servicesOf } from "./locations.ts";
import { type KnownPeople, knownPeople } from "./people.ts";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  formOf,
  ID,
  type ServiceData,
  serviceSchema,
} from "./schemas.ts";

// Anyone can post to a service, and an acceptance is a few small blobs: a
// signature and its signed identity.
const REQUEST_LIMIT = 64 * 1024;

type Schemas = {
  readonly service: Schema<Json, ServiceData>;
  readonly acknowledgement: Schema<Json, AcknowledgementData>;
};

/**
 * The accounts of a service, one for each root of an identity, as the link
 * of the service's signature over the acknowledgement of the acceptance that
 * opened it.
 */
export interface Accounts {
  /**
   * Keeps `acknowledgement` as `root`'s unless it has an account already, in
   * one step, and resolves to whether it was kept.
   */
  add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean>;
}

/** Keeps accounts in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryAccounts implements Accounts {
  readonly #accounts = new Map<Link<KeyObject>, Link<Signature>>();

  async add(root: Link<KeyObject>, acknowledgement: Link<Signature>): Promise<boolean> {
    if (this.#accounts.has(root)) return false;
    this.#accounts.set(root, acknowledgement);
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

/**
 * A mailbox service, as a handler of HTTP requests. `GET /` answers the
 * service's signed Service, and a `POST` to the id that it lists for the
 * offer of an account opens one for whoever signed the offer.
 */
class MailboxService {
  readonly #actor: Actor;
  readonly #offer: EncodedObject<Json, AccountOfferData>;
  readonly #services: ReturnType<typeof servicesOf>;
  readonly #people: KnownPeople;
  readonly #acknowledgements: Acknowledgements;
  readonly #signatures: Signatures;
  readonly #schemas: Schemas;
  readonly #store: Store;
  readonly #accounts: Accounts;
  readonly #clock: () => number;

  constructor(
    actor: Actor,
    { offer, locations }: { readonly offer: EncodedObject<Json, AccountOfferData>; readonly locations: Locations },
    kit: IdentityKit,
    schemas: Schemas,
    { store, accounts, clock }: Required<Pick<ServiceOptions, "store" | "accounts" | "clock">>,
  ) {
    this.#actor = actor;
    this.#offer = offer;
    this.#services = servicesOf(locations, offer.data.identity.$link);
    this.#people = knownPeople(kit, schemas);
    this.#acknowledgements = acknowledgements(kit.signatures, schemas.acknowledgement);
    this.#signatures = kit.signatures;
    this.#schemas = schemas;
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
    const [latest, ...earlier] = await view(this.#store, this.#services);
    if (latest === undefined) throw new Error("the store holds no Service of the service's");
    if (pathname === "/") return answerTo(request, "GET", () => this.#answerWith(latest, 200));
    const id = pathname.slice(1);
    if (!ID.test(id)) return answer(404);
    const people = await view(this.#store, this.#people);
    if (id === this.#offer.link && (await this.#lists(latest, id, people))) {
      return answerTo(request, "POST", () => this.#open(request));
    }
    for (const link of earlier) if (await this.#lists(link, id, people)) return answer(410);
    return answer(404);
  }

  async #lists(link: Link<Signature>, id: string, people: People): Promise<boolean> {
    const { object } = await this.#signatures.read(link, this.#store, people);
    const { offers } = (await readObject(this.#store, object, this.#schemas.service)).data;
    return offers.some(({ accept }) => accept === id);
  }

  /**
   * Acknowledges the signature over the offer that is posted, and opens an
   * account for the root of its identity unless the root has one. Either way
   * the answer is an acknowledgement of this acceptance, one that the store
   * holds or a new one. The signature is judged by the people the service
   * knows once the whole body has come in, however long the sender took to
   * send it, so an agent its root removed is refused even when the root has
   * an account, and even for an acceptance that was acknowledged before.
   */
  async #open(request: Request): Promise<Response> {
    const zip = await readBody(request.body, REQUEST_LIMIT);
    if (zip === undefined) return answer(413, `a request holds at most ${REQUEST_LIMIT} bytes`);
    const at = this.#clock();
    const people = await view(this.#store, this.#people);
    let accepted: Bundle;
    let acceptance: Signature;
    try {
      accepted = await unpackBundle(zip);
      acceptance = await this.#signatures.read(accepted.link, accepted, people);
      if (acceptance.object !== this.#offer.link)
        throw new Error(`the acceptance signs ${acceptance.object}, not the offer`);
      if (people.of(this.#actor.signedIdentity).signed(acceptance))
        throw new Error("a service opens no account for itself");
    } catch (error) {
      return answer(400, error instanceof Error ? error.message : String(error));
    }
    const acknowledgement =
      (await view(this.#store, acknowledgementOf(this.#acknowledgements, acceptance.link))) ??
      (await this.#acknowledge(accepted, acceptance.signedIdentity, at)).link;
    const opened = await this.#accounts.add(acceptance.signedIdentity.identity.root.link, acknowledgement);
    return this.#answerWith(acknowledgement, opened ? 201 : 200);
  }

  /**
   * Signs an acknowledgement of the acceptance `accepted` holds, received
   * `at`, and writes it to the store as mine, so the service knows the
   * version the acceptance carries from then on.
   */
  async #acknowledge(accepted: Bundle, signedIdentity: SignedIdentityObject, at: number): Promise<Signature> {
    const acknowledgement = encodeObject(this.#schemas.acknowledgement, { accepted: { $link: accepted.link }, at });
    const signature = await this.#actor.sign(acknowledgement);
    // Reading the acceptance takes neither the schemas its signed identity
    // leads to nor the interfaces they name, so the bundle need not hold
    // them, and the store takes a blob in only with all it leads to.
    const blobs = [acknowledgement.bytes, this.#schemas.acknowledgement.bytes, ...signedIdentity.blobs];
    await this.#store.write({ mine: [signature], blobs: [...blobs, ...accepted.blobs()] });
    return signature;
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
 * Makes the service of `signer`'s identity at `origin`. The store holds the
 * Services it signed before, the latest of which says where it was and what
 * it offered there. When the service says the same now, that Service stays
 * the latest, and else the service signs a new one. Either way the offer is
 * listed under its link, with the service's signature over it from the
 * latest Service that lists it. The service signs as the signed identity
 * of its latest Service, and publishes its identity only when the store
 * holds no Service of it.
 */
export async function loadMailboxService(
  signer: Signer,
  { origin, validator, clock = Date.now, ...options }: ServiceOptions,
): Promise<MailboxService> {
  if (new URL(origin).origin !== origin)
    throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  const { store } = options;
  const kit = await loadIdentity(validator);
  const { keys, signatures, publish } = kit;
  const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const schemas: Schemas = {
    service: await encodeSchema(serviceSchema, validator),
    acknowledgement: await encodeSchema(acknowledgementSchema, validator),
  };
  const root = keys.encode(signer.key);
  const offer = encodeObject(offerSchema, { identity: { $link: root.link } });
  const index = locations(signatures, schemas.service);

  const people = await view(store, knownPeople(kit, schemas));
  const signed = await Promise.all(
    (await view(store, servicesOf(index, root.link))).map((link) => signatures.read(link, store, people)),
  );
  const [latest] = signed;
  const at = clock();
  const actor = signatures.actor(signer, latest?.signedIdentity ?? (await publish(signer, at)));
  const services = await Promise.all(signed.map(({ object }) => readObject(store, object, schemas.service)));
  const [previous] = services;
  const signature = (await signedIn(services, offer.link, signatures, store, people)) ?? (await actor.sign(offer));
  const next: ServiceData = {
    origin,
    at,
    offers: [{ offer: { $link: signature.link }, accept: offer.link }],
  };
  if (previous === undefined || formOf(previous.data) !== formOf(next)) {
    const object = encodeObject(schemas.service, next);
    const blobs = [
      object.bytes,
      schemas.service.bytes,
      signature.bytes,
      offer.bytes,
      offerSchema.bytes,
      signatures.schema.bytes,
      ...actor.signedIdentity.blobs,
    ];
    await store.write({ mine: [await actor.sign(object)], blobs });
  }
  return new MailboxService(actor, { offer, locations: index }, kit, schemas, { ...options, clock });
}

/** The service's signature over `offer`, as the first of `services` that lists the offer lists it, when one does. */
async function signedIn(
  services: readonly EncodedObject<Json, ServiceData>[],
  offer: Link<unknown>,
  signatures: Signatures,
  store: Store,
  people: People,
): Promise<Signature | undefined> {
  for (const { data } of services) {
    for (const { offer: listed } of data.offers) {
      const signature = await signatures.read(listed.$link, store, people);
      if (signature.object === offer) return signature;
    }
  }
  return undefined;
}
