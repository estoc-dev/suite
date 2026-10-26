import { loadAuthorizations, type Authorization, type Authorizations, type Signed } from "@estoc/authorization";
import type { Bundle } from "@estoc/bundle";
import type { Signer } from "@estoc/identity";
import {
  encodeSchema,
  readObject,
  type Bytes,
  type EncodedObject,
  type IdentityObject,
  type Json,
  type JsonSchemaValidator,
  type Link,
  type Schema,
  type Signature,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { readBody, unzipped, ZIP, zipped } from "./http.ts";
import { accountOfferSchema, acknowledgementSchema, type AccountOfferData, type AcknowledgementData } from "./schemas.ts";

// The answers hold an acceptance and a few blobs of the service's. The
// client chose the service, so this only bounds what it reads.
const ANSWER_LIMIT = 1024 * 1024;
const REASON_LIMIT = 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A redirect would take the request to an origin other than the one whose
// offer the client holds.
const REQUEST = { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" } as const satisfies RequestInit;

/** An identity's account at a service, written to the store. */
export interface Account {
  /** The identity whose account it is: the signer's, or the principal's that the signer acted for. */
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

type Offered = {
  readonly origin: string;
  readonly bundle: Bundle;
  readonly offer: EncodedObject<Json, AccountOfferData>;
  readonly signature: Signature;
};

type Accept = (signer: Signer, chain: readonly Signed<Authorization>[]) => Promise<Account>;

/** A service's offer of an account, read from the service's origin and bound to it. */
export class Offer {
  readonly origin: string;
  /** The service's identity, which the offer names and which signed it. */
  readonly service: IdentityObject;
  readonly link: Link<EncodedObject<Json, AccountOfferData>>;
  readonly #accept: Accept;

  constructor({ origin, offer, signature }: Offered, accept: Accept) {
    this.origin = origin;
    this.service = signature.identity;
    this.link = offer.link;
    this.#accept = accept;
  }

  /**
   * Opens an account by accepting the offer: for the signer's identity, which
   * signs the offer, or with `chain`, for the principal that the chain starts
   * at, with the signer signing a proxy for it as the chain's last agent.
   * Writes the service's signatures over the offer and over the
   * acknowledgement to the store as mine, with all they lead to. An identity
   * that has an account there already gets the acknowledgement of the
   * acceptance that opened it, which may have come from another device.
   */
  accept(signer: Signer, chain: readonly Signed<Authorization>[] = []): Promise<Account> {
    return this.#accept(signer, chain);
  }
}

/** Mailbox services as a client reaches them, with a store that keeps the accounts it opens. */
export class Services {
  readonly #store: Store;
  readonly #authorizations: Authorizations;
  readonly #offerSchema: Schema<Json, AccountOfferData>;
  readonly #acknowledgementSchema: Schema<Json, AcknowledgementData>;

  constructor(
    store: Store,
    authorizations: Authorizations,
    offer: Schema<Json, AccountOfferData>,
    acknowledgement: Schema<Json, AcknowledgementData>,
  ) {
    this.#store = store;
    this.#authorizations = authorizations;
    this.#offerSchema = offer;
    this.#acknowledgementSchema = acknowledgement;
  }

  /**
   * Gets the offer of the service at `origin`, such as `https://mail.example`.
   * What the origin answers over TLS is the service's, so the identity that
   * signed the offer is taken as the service's; an offer signed by another
   * identity than the one it names is refused.
   */
  async offer(origin: string): Promise<Offer> {
    checkOrigin(origin);
    const bundle = await bundleIn(await fetch(new URL("/offer", origin), REQUEST), [200]);
    const signature = await this.#authorizations.signatures.read(bundle.link, bundle);
    const offer = await readObject(bundle, signature.object, this.#offerSchema);
    if (offer.data.identity.$link !== signature.identity.link) {
      throw new Error(`the offer of ${origin} is signed by another identity than the one it names`);
    }
    const offered = { origin, bundle, offer, signature };
    return new Offer(offered, (signer, chain) => this.#accept(offered, signer, chain));
  }

  async #accept({ origin, bundle, offer, signature }: Offered, signer: Signer, chain: readonly Signed<Authorization>[]): Promise<Account> {
    const { entry, principal, blobs } = await this.#acceptance(offer, signer, chain);
    const request = { ...REQUEST, method: "POST", headers: { "content-type": ZIP }, body: await zipped(entry, blobs) };
    const answer = await bundleIn(await fetch(new URL("/", origin), request), [200, 201]);
    const acknowledgement = await this.#authorizations.signatures.read(answer.link, answer);
    const service = signature.identity;
    if (acknowledgement.identity.link !== service.link) {
      throw new Error("the acknowledgement is signed by another identity than the service's");
    }
    const { accepted, at } = (await readObject(answer, acknowledgement.object, this.#acknowledgementSchema)).data;
    // The acceptance that opened an account stood when the service received
    // it, though an authorization in its chain may have ended since.
    const { principal: holder } = await this.#authorizations.readStanding(offer.link, accepted.$link, answer, new Date(at));
    if (holder.link !== principal.link) throw new Error("the acknowledgement is of another identity's account");
    await this.#store.write({ mine: [acknowledgement, signature], blobs: [...answer.blobs(), ...bundle.blobs()] });
    return { identity: principal, service, at, link: acknowledgement.link };
  }

  /**
   * The signature that accepts the offer, the identity it stands behind the
   * offer, and the blobs the service reads it with. The service holds the
   * offer and the schemas, so they are left out.
   */
  async #acceptance(
    offer: EncodedObject<Json, AccountOfferData>,
    signer: Signer,
    chain: readonly Signed<Authorization>[],
  ): Promise<{ readonly entry: Signature; readonly principal: IdentityObject; readonly blobs: readonly Bytes<unknown>[] }> {
    const [first] = chain;
    if (first === undefined) {
      const entry = await this.#authorizations.signatures.sign(offer, signer);
      return { entry, principal: entry.identity, blobs: [entry.identity.bytes] };
    }
    const { object, signature } = await this.#authorizations.proxy(offer.link, chain, signer);
    const grants = chain.flatMap(({ object, signature }) => [signature.bytes, signature.identity.bytes, object.bytes, object.agent.bytes]);
    return { entry: signature, principal: first.signature.identity, blobs: [signature.identity.bytes, object.bytes, ...grants] };
  }
}

// Plain http is for the client's own machine alone, as in development: the
// origin is what makes the offer the service's, and only TLS says that an
// answer came from it.
function checkOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error(`${origin} is not an origin, which is a scheme, a host and a port alone`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error(`a service is reached over https, or over http on this machine, not at ${origin}`);
  }
}

async function bundleIn(response: Response, statuses: readonly number[]): Promise<Bundle> {
  if (!statuses.includes(response.status)) {
    const reason = await readBody(response.body, REASON_LIMIT);
    const said = reason === undefined || reason.length === 0 ? "" : `: ${new TextDecoder().decode(reason)}`;
    throw new Error(`the service answered ${response.status}${said}`);
  }
  const zip = await readBody(response.body, ANSWER_LIMIT);
  if (zip === undefined) throw new Error(`the service answered more than ${ANSWER_LIMIT} bytes`);
  return unzipped(zip);
}

/** Reaches mailbox services for the identities of the user of `store`, which keeps the accounts opened. */
export async function loadServices(store: Store, { validator }: { readonly validator: JsonSchemaValidator }): Promise<Services> {
  const authorizations = await loadAuthorizations(validator);
  const offer: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, validator);
  const acknowledgement: Schema<Json, AcknowledgementData> = await encodeSchema(acknowledgementSchema, validator);
  return new Services(store, authorizations, offer, acknowledgement);
}
