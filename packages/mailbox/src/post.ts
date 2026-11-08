import type { Bundle } from "@estoc/bundle";
import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type Json,
  type JsonSchema,
  type JsonSchemaValidator,
  type Link,
  linkOf,
  readObject,
  type Schema,
} from "@estoc/object";
import { type PrivateStore, RefusedBatch, type Store } from "@estoc/store";
import { hex } from "@scure/base";
import { MailboxKey } from "./key.ts";
import { type Mailbox, mailboxFrom, type Options, readMailbox, type Transport } from "./mailbox.ts";
import type { Pickup } from "./pickup.ts";
import { type DeliveryData, inboundSchema, type MailboxKeyData, mailboxKeySchema, outboundSchema } from "./schema.ts";

export interface PostOptions extends Options {
  /** The validator that the schemas of the records are compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

type Direction = "inbound" | "outbound";

/** A record, written to a store, that a bundle came in at a mailbox or went out to one. */
export interface Delivery {
  readonly direction: Direction;
  /** The link of the bundle's root. */
  readonly bundle: Link<never>;
  readonly mailbox: Link<EncodedObject<Json>>;
  /** When, in milliseconds since the Unix epoch, by the clock of the device that wrote the record. */
  readonly at: number;
  /** The link of the record. */
  readonly link: Link<EncodedObject<Json>>;
}

type DeliveryRecorder = (bundle: Link<never>, blobs?: Iterable<Bytes<unknown>>) => Promise<Delivery>;

type MailboxBytes = { readonly bytes: Bytes<EncodedObject<Json>> };

interface Schemas extends Readonly<Record<Direction, Schema<Json, DeliveryData>>> {
  readonly key: Schema<Json, MailboxKeyData>;
}

/**
 * Sending and receiving with a store.
 *
 * - What is sent is taken from the store, and what arrives is kept in it.
 * - Each is recorded there as a delivery that the user writes, an object of `inboundSchema` or
 *   `outboundSchema`, listed with the store's other records for the application to read into its
 *   indexes.
 * - The keys that open what arrives are objects of `mailboxKeySchema` in a private store beside the
 *   store, so no bundle gathered from the store carries one.
 */
export class Post {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #schemas: Schemas;

  constructor(
    store: Store,
    privateStore: PrivateStore,
    transports: readonly Transport[],
    clock: () => number,
    schemas: Schemas,
  ) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#transports = transports;
    this.#clock = clock;
    this.#schemas = schemas;
  }

  /** A mailbox that the store holds, to send what the store holds to. */
  async outbox(mailbox: Link<EncodedObject<Json>>): Promise<Outbox> {
    const bound = await mailboxFrom(await this.#bytesAt(mailbox), { transports: this.#transports });
    return new Outbox(bound, this.#store, (bundle) => this.#write("outbound", mailbox, bundle));
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
    const { bytes } = await makeMailbox(key.publicKey);
    const { data, transport } = readMailbox(bytes, this.#transports);
    if (data.key !== hex.encode(key.publicKey))
      throw new Error("the mailbox made names another key than the one given");
    const mailbox = linkOf(bytes);
    await this.#store.write({ records: [{ bytes }], blobs: transport.schema.blobs });
    const schema = this.#schemas.key;
    const object = encodeObject(schema, { mailbox: { $link: mailbox }, secret: hex.encode(secret) });
    await this.#privateStore.write({ records: [object], blobs: schema.blobs });
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
    const { data } = await readObject(this.#privateStore, key, this.#schemas.key);
    const mailbox = data.mailbox.$link;
    const named = readMailbox(await this.#bytesAt(mailbox), this.#transports).data.key;
    const opener = await MailboxKey.fromSecretKey(hex.decode(data.secret));
    if (named !== hex.encode(opener.publicKey)) throw new Error(`${mailbox} names another key than ${key} holds`);
    return this.#inbox(mailbox, key, opener);
  }

  #inbox(mailbox: Link<EncodedObject<Json>>, key: Link<EncodedObject<Json, MailboxKeyData>>, opener: MailboxKey) {
    return new Inbox(mailbox, key, opener, (bundle, blobs) => this.#write("inbound", mailbox, bundle, blobs));
  }

  async #bytesAt(link: Link<unknown>): Promise<Uint8Array> {
    const bytes = await this.#store.get(link);
    if (bytes === undefined) throw new Error(`the store does not hold ${link}`);
    return bytes;
  }

  async #write(
    direction: Direction,
    mailbox: Link<EncodedObject<Json>>,
    bundle: Link<never>,
    blobs: Iterable<Bytes<unknown>> = [],
  ): Promise<Delivery> {
    const schema = this.#schemas[direction];
    const at = this.#clock();
    const record = encodeObject(schema, { bundle: { $link: bundle }, mailbox: { $link: mailbox }, at });
    await this.#store.write({ records: [record], blobs: [...schema.blobs, ...blobs] });
    return { direction, bundle, mailbox, at, link: record.link };
  }
}

/** A mailbox bound to a store, to send what the store holds to. */
export class Outbox {
  readonly #mailbox: Mailbox;
  readonly #store: Store;
  readonly #record: DeliveryRecorder;

  constructor(mailbox: Mailbox, store: Store, record: DeliveryRecorder) {
    this.#mailbox = mailbox;
    this.#store = store;
    this.#record = record;
  }

  /**
   * Sends `root` and its closure in the store as a bundle, whoever wrote it, and once the transport
   * takes the bundle, writes that it went out. Sending a root again sends the same bundle and
   * writes another record.
   *
   * @throws when the store does not hold `root`.
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
  /** The link of the mailbox, which the store holds. */
  readonly mailbox: Link<EncodedObject<Json>>;
  /**
   * The link of the mailbox's key, which the private store keeps, for `Post.inbox` to make this
   * inbox again.
   */
  readonly key: Link<EncodedObject<Json, MailboxKeyData>>;
  readonly #opener: MailboxKey;
  readonly #record: DeliveryRecorder;

  constructor(
    mailbox: Link<EncodedObject<Json>>,
    key: Link<EncodedObject<Json, MailboxKeyData>>,
    opener: MailboxKey,
    record: DeliveryRecorder,
  ) {
    this.mailbox = mailbox;
    this.key = key;
    this.#opener = opener;
    this.#record = record;
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
    const bundle = await this.#opener.open(ciphertext);
    return this.#record(bundle.link, bundle.blobs());
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
      return await this.#record(bundle.link, bundle.blobs());
    } catch (error) {
      if (error instanceof RefusedBatch) return undefined;
      throw error;
    }
  }
}

/**
 * Makes a post that sends and receives with `store`, through `transports`,
 * and keeps the keys of the user's mailboxes in `privateStore`, beside
 * `store`.
 */
export async function loadPost(
  store: Store,
  privateStore: PrivateStore,
  { transports, validator, clock = Date.now }: PostOptions,
): Promise<Post> {
  const compile = <F extends Fields<Json>>(schema: JsonSchema): Promise<Schema<Json, F>> =>
    encodeSchema(schema, validator);
  const [inbound, outbound, key] = await Promise.all([
    compile<DeliveryData>(inboundSchema),
    compile<DeliveryData>(outboundSchema),
    compile<MailboxKeyData>(mailboxKeySchema),
  ]);
  return new Post(store, privateStore, transports, clock, { inbound, outbound, key });
}
