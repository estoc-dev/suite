import type { Bundle } from "@estoc/bundle";
import type { Actor } from "@estoc/identity";
import { type Bytes, type EncodedObject, encodeObject, type Json, type Link, readObject } from "@estoc/object";
import { Intake, type PrivateStore, RefusedBatch, type Store } from "@estoc/store";
import { hex } from "@scure/base";
import { Correspondence, type CorrespondenceIdentity } from "./correspondence.ts";
import { MailboxGrants } from "./grant.ts";
import { MailboxKey } from "./key.ts";
import { type Mailbox, mailboxFrom, type Options, readMailbox, type Transport } from "./mailbox.ts";
import type { Pickup } from "./pickup.ts";
import { type MailboxKeyData, mailboxKeySchema, outboundSchema } from "./schema.ts";

export interface PostOptions extends Options {
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/** A record, written to a store, that a bundle came in at a mailbox or went out to one. */
export interface Delivery {
  readonly direction: "inbound" | "outbound";
  /** The link of the bundle's root. */
  readonly bundle: Link<never>;
  readonly mailbox: Link<EncodedObject<Json>>;
  /** When, in milliseconds since the Unix epoch, by the clock of the device that wrote the record. */
  readonly at: number;
  /** The link of the record. */
  readonly link: Link<EncodedObject<Json>>;
}

type MailboxBytes = { readonly bytes: Bytes<EncodedObject<Json>> };

/**
 * Sending and receiving with a store, through transports, with the keys of
 * the user's mailboxes kept in a private store beside the store.
 *
 * - What is sent is taken from the store, and what arrives is kept in it.
 * - Each is recorded there as a delivery that the user writes, an object of `outboundSchema` or of
 *   `inboundSchema` in `@estoc/store`, listed with the store's other records for the application to
 *   read into its indexes.
 * - The keys that open what arrives are objects of `mailboxKeySchema` in a private store beside the
 *   store, so no bundle gathered from the store carries one.
 */
export class Post {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #intake: Intake;

  constructor(store: Store, privateStore: PrivateStore, { transports, clock = Date.now }: PostOptions) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#transports = transports;
    this.#clock = clock;
    this.#intake = new Intake(store, clock);
  }

  /** Sending and reading as `actor`, by the Mailbox Grants and the identity versions the store holds. */
  correspondenceAs(actor: Actor, identity: CorrespondenceIdentity): Correspondence {
    return new Correspondence(this.#store, this, actor, this.#clock, new MailboxGrants(identity), identity);
  }

  /** A mailbox that the store holds, to send what the store holds to. */
  async outbox(mailbox: Link<EncodedObject<Json>>): Promise<Outbox> {
    const boundMailbox = await mailboxFrom(await this.#bytesAt(mailbox), { transports: this.#transports });
    return new Outbox(boundMailbox, this.#store, (bundle) => this.#recordOutbound(mailbox, bundle));
  }

  /**
   * Opens a mailbox of the user's with a new key, to receive at. `makeMailbox` is given the public
   * key and gives back a mailbox sealed to it, as the transport makes one. The mailbox is written
   * to the store and then its key to the private store, so a stop in between leaves at most a
   * mailbox that nobody receives at.
   *
   * @throws when the mailbox is of a transport the post was not given, or names another key;
   *   nothing is written then.
   */
  async openInbox(makeMailbox: (publicKey: Uint8Array) => MailboxBytes | Promise<MailboxBytes>): Promise<Inbox> {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const key = await MailboxKey.fromSecretKey(secret);
    const { mailbox, data } = readMailbox((await makeMailbox(key.publicKey)).bytes, this.#transports);
    if (data.key !== hex.encode(key.publicKey))
      throw new Error("the mailbox made names another key than the one given");
    await this.#store.write({ records: [mailbox], blobs: mailbox.schema.blobs });
    const object = encodeObject(mailboxKeySchema, { mailbox: { $link: mailbox.link }, secret: hex.encode(secret) });
    await this.#privateStore.write({ records: [object], blobs: mailboxKeySchema.blobs });
    return this.#inbox(mailbox, object.link, key);
  }

  /**
   * The inbox of a key that the private store keeps, at the mailbox the key names, which the store
   * holds.
   *
   * @throws when the key's secret is not of the public key the mailbox names: what it opens was
   *   sealed to another mailbox.
   */
  async inbox(key: Link<EncodedObject<Json, MailboxKeyData>>): Promise<Inbox> {
    const { data } = await readObject(this.#privateStore, key, mailboxKeySchema);
    const { mailbox, data: mailboxData } = readMailbox(await this.#bytesAt(data.mailbox.$link), this.#transports);
    const opener = await MailboxKey.fromSecretKey(hex.decode(data.secret));
    if (mailboxData.key !== hex.encode(opener.publicKey))
      throw new Error(`${mailbox.link} names another key than ${key} holds`);
    return this.#inbox(mailbox, key, opener);
  }

  #inbox(mailbox: EncodedObject<Json>, key: Link<EncodedObject<Json, MailboxKeyData>>, opener: MailboxKey) {
    return new Inbox(mailbox, key, opener, this.#intake);
  }

  async #bytesAt(link: Link<unknown>): Promise<Uint8Array> {
    const bytes = await this.#store.get(link);
    if (bytes === undefined) throw new Error(`the store does not hold ${link}`);
    return bytes;
  }

  async #recordOutbound(mailbox: Link<EncodedObject<Json>>, bundle: Link<never>): Promise<Delivery> {
    const at = this.#clock();
    const record = encodeObject(outboundSchema, { bundle: { $link: bundle }, mailbox: { $link: mailbox }, at });
    await this.#store.write({ records: [record], blobs: outboundSchema.blobs });
    return { direction: "outbound", bundle, mailbox, at, link: record.link };
  }
}

/** A mailbox bound to a store, to send what the store holds to. */
export class Outbox {
  readonly #mailbox: Mailbox;
  readonly #store: Store;
  readonly #record: (bundle: Link<never>) => Promise<Delivery>;

  constructor(mailbox: Mailbox, store: Store, record: (bundle: Link<never>) => Promise<Delivery>) {
    this.#mailbox = mailbox;
    this.#store = store;
    this.#record = record;
  }

  /**
   * Sends `root` and its closure in the store as a bundle, whoever wrote it, and once the transport
   * takes the bundle, writes that it went out. Sending a root again sends the same bundle and
   * writes another record.
   *
   * @throws when the store does not hold `root` or a blob of its closure; nothing is sent then.
   * @throws {UndeliveredMessage} when the transport cannot hand the bundle on; nothing is written
   *   then.
   */
  async send(root: Link<unknown>): Promise<Delivery> {
    const closure = await this.#store.closure(root);
    const bytes = closure.get(root);
    if (bytes === undefined) throw new Error(`the store does not hold ${root}`);
    await this.#mailbox.send(
      { bytes },
      [...closure].filter(([link]) => link !== root).map(([, blob]) => blob),
    );
    return this.#record(root as Link<never>);
  }
}

/** A mailbox of the user's bound to its key and a store, to keep what arrives there. */
export class Inbox {
  /**
   * The link of the mailbox's key, which the private store keeps, for `Post.inbox` to make this
   * inbox again.
   */
  readonly key: Link<EncodedObject<Json, MailboxKeyData>>;
  readonly #mailbox: EncodedObject<Json>;
  readonly #opener: MailboxKey;
  readonly #intake: Intake;

  constructor(
    mailbox: EncodedObject<Json>,
    key: Link<EncodedObject<Json, MailboxKeyData>>,
    opener: MailboxKey,
    intake: Intake,
  ) {
    this.#mailbox = mailbox;
    this.key = key;
    this.#opener = opener;
    this.#intake = intake;
  }

  /** The link of the mailbox, which the store holds. */
  get mailbox(): Link<EncodedObject<Json>> {
    return this.#mailbox.link;
  }

  /**
   * Opens a ciphertext that arrived at the mailbox, and keeps the bundle inside with a record that
   * it came in. What arrives twice is recorded twice, once for each time it came in.
   *
   * @throws when the ciphertext does not open with the mailbox's key; nothing is kept then.
   * @throws {RefusedBatch} when the bundle leaves out a blob in its root's closure that the store
   *   does not hold; nothing is kept then.
   */
  async receive(ciphertext: Uint8Array): Promise<Delivery> {
    return this.#keep(await this.#opener.open(ciphertext));
  }

  /**
   * Receives what waits at the mailbox, one arrival at a time, and gives back the records it wrote.
   *
   * - It is done with each arrival once it is kept.
   * - What does not open, and a bundle that the store refuses, are done with too and leave no
   *   record, rather than wait for the blobs a bundle leaves out to reach the store.
   *
   * @throws when `pickup` is of another mailbox; nothing is done with then.
   * @throws when the store fails to write; that arrival is not done with, and waits to be
   *   collected again.
   */
  async collect(pickup: Pickup, signal?: AbortSignal): Promise<Delivery[]> {
    if (pickup.mailbox !== this.mailbox)
      throw new Error(`a pickup of ${pickup.mailbox} is not collected at ${this.mailbox}`);
    const deliveries: Delivery[] = [];
    for await (const arrival of pickup.arrivals(signal)) {
      const delivery = await this.#tryReceive(arrival.ciphertext);
      if (delivery !== undefined) deliveries.push(delivery);
      await arrival.drop();
    }
    return deliveries;
  }

  async #tryReceive(ciphertext: Uint8Array): Promise<Delivery | undefined> {
    let bundle: Bundle;
    try {
      bundle = await this.#opener.open(ciphertext);
    } catch {
      return undefined;
    }
    try {
      return await this.#keep(bundle);
    } catch (error) {
      if (error instanceof RefusedBatch) return undefined;
      throw error;
    }
  }

  async #keep(bundle: Bundle): Promise<Delivery> {
    const { link, data } = await this.#intake.receive(bundle, this.#mailbox);
    return { direction: "inbound", bundle: bundle.link, mailbox: this.mailbox, at: data.at, link };
  }
}
