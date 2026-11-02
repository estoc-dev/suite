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

type Written = (bundle: Link<never>, blobs?: Iterable<Bytes<unknown>>) => Promise<Delivery>;

type MailboxBytes = { readonly bytes: Bytes<EncodedObject<Json>> };

interface Schemas extends Readonly<Record<Direction, Schema<Json, DeliveryData>>> {
  readonly key: Schema<Json, MailboxKeyData>;
}

/**
 * Sending and receiving with a store. What is sent is taken from the store,
 * what arrives is kept in it, and each is recorded there as a delivery that
 * the user writes, an object of `inboundSchema` or `outboundSchema`. The
 * records are listed with the rest of what the user wrote, for the
 * application to read into its indexes. The keys that open what arrives are
 * objects of `mailboxKeySchema` in a private store beside the store, so no
 * bundle gathered from the store carries one.
 */
export class Post {
  readonly #store: Store;
  readonly #kept: PrivateStore;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #schemas: Schemas;

  constructor(
    store: Store,
    kept: PrivateStore,
    transports: readonly Transport[],
    clock: () => number,
    schemas: Schemas,
  ) {
    this.#store = store;
    this.#kept = kept;
    this.#transports = transports;
    this.#clock = clock;
    this.#schemas = schemas;
  }

  /** A mailbox that the store holds, to send what the store holds to. */
  async outbox(mailbox: Link<EncodedObject<Json>>): Promise<Outbox> {
    const bound = await mailboxFrom(await this.#held(mailbox), { transports: this.#transports });
    return new Outbox(bound, this.#store, (bundle) => this.#write("outbound", mailbox, bundle));
  }

  /**
   * Opens a mailbox of the user's with a new key, to receive at. `make` is
   * given the public key and gives back a mailbox sealed to it, as the
   * transport makes one. The mailbox is written to the store and then its
   * key to the private store, so a stop in between leaves at most a mailbox
   * that nobody receives at. Refuses a mailbox of a transport the post was
   * not given, or one that names another key, and writes nothing.
   */
  async openInbox(make: (publicKey: Uint8Array) => MailboxBytes | Promise<MailboxBytes>): Promise<Inbox> {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const key = await MailboxKey.fromSecretKey(secret);
    const { bytes } = await make(key.publicKey);
    const { data, transport } = readMailbox(bytes, this.#transports);
    if (data.key !== hex.encode(key.publicKey))
      throw new Error("the mailbox made names another key than the one given");
    const mailbox = linkOf(bytes);
    await this.#store.write({ mine: [{ bytes }], blobs: [transport.schema.bytes] });
    const schema = this.#schemas.key;
    const object = encodeObject(schema, { mailbox: { $link: mailbox }, secret: hex.encode(secret) });
    await this.#kept.write({ mine: [object], blobs: [schema.bytes] });
    return this.#inbox(mailbox, object.link, key);
  }

  /**
   * The inbox of a key that the private store keeps, at the mailbox the key
   * names, which the store holds. Refuses a key whose secret is not of the
   * public key the mailbox names: what it opens was sealed to another
   * mailbox.
   */
  async inbox(key: Link<EncodedObject<Json, MailboxKeyData>>): Promise<Inbox> {
    const { data } = await readObject(this.#kept, key, this.#schemas.key);
    const mailbox = data.mailbox.$link;
    const named = readMailbox(await this.#held(mailbox), this.#transports).data.key;
    const opener = await MailboxKey.fromSecretKey(hex.decode(data.secret));
    if (named !== hex.encode(opener.publicKey)) throw new Error(`${mailbox} names another key than ${key} holds`);
    return this.#inbox(mailbox, key, opener);
  }

  #inbox(mailbox: Link<EncodedObject<Json>>, key: Link<EncodedObject<Json, MailboxKeyData>>, opener: MailboxKey) {
    return new Inbox(mailbox, key, opener, (bundle, blobs) => this.#write("inbound", mailbox, bundle, blobs));
  }

  async #held(link: Link<unknown>): Promise<Uint8Array> {
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
    await this.#store.write({ mine: [record], blobs: [schema.bytes, ...blobs] });
    return { direction, bundle, mailbox, at, link: record.link };
  }
}

/** A mailbox bound to a store, to send what the store holds to. */
export class Outbox {
  readonly #mailbox: Mailbox;
  readonly #store: Store;
  readonly #written: Written;

  constructor(mailbox: Mailbox, store: Store, written: Written) {
    this.#mailbox = mailbox;
    this.#store = store;
    this.#written = written;
  }

  /**
   * Sends the bundle of `root` and all it leads to in the store, whoever
   * wrote it. Once the transport takes the bundle, writes that it went out.
   * When the transport cannot hand it on, rejects with its `Undelivered` and
   * writes nothing. Sending a root again sends the same bundle and writes
   * another record.
   */
  async send(root: Link<unknown>): Promise<Delivery> {
    const closure = await this.#store.closure(root);
    const bytes = closure.get(root);
    if (bytes === undefined) throw new Error(`the store does not hold ${root}`);
    await this.#mailbox.send(
      { bytes },
      [...closure].filter(([link]) => link !== root).map(([, blob]) => blob),
    );
    return this.#written(root as Link<never>);
  }
}

/** A mailbox of the user's bound to its key and a store, to keep what arrives there. */
export class Inbox {
  /** The link of the mailbox, which the store holds. */
  readonly mailbox: Link<EncodedObject<Json>>;
  /** The link of the mailbox's key, which the private store keeps, for `Post.inbox` to make this inbox again. */
  readonly key: Link<EncodedObject<Json, MailboxKeyData>>;
  readonly #opener: MailboxKey;
  readonly #written: Written;

  constructor(
    mailbox: Link<EncodedObject<Json>>,
    key: Link<EncodedObject<Json, MailboxKeyData>>,
    opener: MailboxKey,
    written: Written,
  ) {
    this.mailbox = mailbox;
    this.key = key;
    this.#opener = opener;
    this.#written = written;
  }

  /**
   * Opens sealed bytes that arrived at the mailbox, and keeps the bundle
   * inside with a record that it came in. Keeps nothing when they do not
   * open, or when the bundle leaves out a blob that its root leads to and
   * the store does not hold. What arrives twice is recorded twice, once for
   * each time it came in.
   */
  async receive(sealed: Uint8Array): Promise<Delivery> {
    const bundle = await this.#opener.open(sealed);
    return this.#written(bundle.link, bundle.blobs());
  }

  /**
   * Receives what waits at the mailbox, one arrival at a time, and is done
   * with each once it is kept. Gives back the records it wrote. What does
   * not open, and a bundle that the store refuses, are done with too and
   * leave no record, rather than wait for the blobs a bundle leaves out to
   * reach the store. When the store fails to write, stops and rejects, and
   * that arrival waits to be collected again. Refuses a pickup of another
   * mailbox, and is done with nothing.
   */
  async collect(pickup: Pickup, signal?: AbortSignal): Promise<Delivery[]> {
    if (pickup.mailbox !== this.mailbox)
      throw new Error(`a pickup of ${pickup.mailbox} is not collected at ${this.mailbox}`);
    const written: Delivery[] = [];
    for await (const arrival of pickup.arrivals(signal)) {
      const delivery = await this.#kept(arrival.sealed);
      if (delivery !== undefined) written.push(delivery);
      await arrival.done();
    }
    return written;
  }

  async #kept(sealed: Uint8Array): Promise<Delivery | undefined> {
    let bundle: Bundle;
    try {
      bundle = await this.#opener.open(sealed);
    } catch {
      return undefined;
    }
    try {
      return await this.#written(bundle.link, bundle.blobs());
    } catch (error) {
      if (error instanceof RefusedBatch) return undefined;
      throw error;
    }
  }
}

/**
 * Makes a post that sends and receives with `store`, through `transports`,
 * and keeps the keys of the user's mailboxes in `kept`, a private store
 * beside `store`.
 */
export async function loadPost(
  store: Store,
  kept: PrivateStore,
  { transports, validator, clock = Date.now }: PostOptions,
): Promise<Post> {
  const compile = <F extends Fields<Json>>(schema: JsonSchema): Promise<Schema<Json, F>> =>
    encodeSchema(schema, validator);
  const [inbound, outbound, key] = await Promise.all([
    compile<DeliveryData>(inboundSchema),
    compile<DeliveryData>(outboundSchema),
    compile<MailboxKeyData>(mailboxKeySchema),
  ]);
  return new Post(store, kept, transports, clock, { inbound, outbound, key });
}
