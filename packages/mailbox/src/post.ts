import {
  decodeObject,
  encodeObject,
  encodeSchema,
  json,
  schemaOf,
  type Bytes,
  type EncodedObject,
  type Json,
  type JsonLink,
  type JsonSchemaValidator,
  type Link,
  type Schema,
} from "@estoc/object";
import type { Store } from "@estoc/store";
import { hex } from "@scure/base";
import type { MailboxKey } from "./key.ts";
import { mailboxFrom, readMailbox, type Mailbox, type Options, type Transport } from "./mailbox.ts";
import { deliverySchema } from "./schema.ts";

export interface PostOptions extends Options {
  /** The validator that the schemas of the records are compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

type Direction = "inbound" | "outbound";

/** A record, read from a store, that a bundle came in at a mailbox or went out to one. */
export interface Delivery {
  readonly direction: Direction;
  /** The link of the bundle's root. */
  readonly bundle: Link<never>;
  readonly mailbox: Link<EncodedObject<Json>>;
  /** When, in milliseconds since the Unix epoch, by the clock of the device that wrote the record. */
  readonly at: number;
  /** The link of the record. */
  readonly link: Link<unknown>;
}

type Written = (bundle: Link<never>, blobs?: Iterable<Bytes<unknown>>) => Promise<Delivery>;

/**
 * Sending and receiving with a store. What is sent is taken from the store,
 * what arrives is kept in it, and each is recorded there as a delivery that
 * the user writes, inbound or outbound. The records are listed with the
 * rest of what the user wrote, and `read` reads them back.
 */
export class Post {
  readonly #store: Store;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #schemas: Readonly<Record<Direction, Schema<Json>>>;

  constructor(
    store: Store,
    transports: readonly Transport[],
    clock: () => number,
    schemas: Readonly<Record<Direction, Schema<Json>>>,
  ) {
    this.#store = store;
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
   * A mailbox of the user's that the store holds, bound to the key that opens
   * what arrives there. Refuses a key other than the one the mailbox names:
   * what that key opened was sealed to another mailbox.
   */
  async inbox(mailbox: Link<EncodedObject<Json>>, key: MailboxKey): Promise<Inbox> {
    const { data } = readMailbox(await this.#held(mailbox), this.#transports);
    if (data.key !== hex.encode(key.publicKey)) throw new Error(`${mailbox} names another key than the one given`);
    return new Inbox(key, (bundle, blobs) => this.#write("inbound", mailbox, bundle, blobs));
  }

  /** The delivery that `link` names in the store, or `undefined` when it names an object of another schema. */
  async read(link: Link<unknown>): Promise<Delivery | undefined> {
    const bytes = await this.#held(link);
    const named = schemaOf(bytes, json);
    const direction = (["inbound", "outbound"] as const).find((each) => this.#schemas[each].link === named);
    if (direction === undefined) return undefined;
    const { data } = decodeObject(bytes, this.#schemas[direction]);
    const { bundle, mailbox, at } = data as {
      readonly bundle: JsonLink<never>;
      readonly mailbox: JsonLink<EncodedObject<Json>>;
      readonly at: number;
    };
    return { direction, bundle: bundle.$link, mailbox: mailbox.$link, at, link };
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
    const record = encodeObject<Json>(schema, { bundle: { $link: bundle }, mailbox: { $link: mailbox }, at });
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
   * wrote it. Once the transport takes the bundle, writes that it went out,
   * and writes nothing when the transport refuses it. Sending a root again
   * sends the same bundle and writes another record.
   */
  async send(root: Link<unknown>): Promise<Delivery> {
    const closure = await this.#store.closure(root);
    const bytes = closure.get(root);
    if (bytes === undefined) throw new Error(`the store does not hold ${root}`);
    await this.#mailbox.send({ bytes }, [...closure].filter(([link]) => link !== root).map(([, blob]) => blob));
    return this.#written(root as Link<never>);
  }
}

/** A mailbox of the user's bound to its key and a store, to keep what arrives there. */
export class Inbox {
  readonly #key: MailboxKey;
  readonly #written: Written;

  constructor(key: MailboxKey, written: Written) {
    this.#key = key;
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
    const bundle = await this.#key.open(sealed);
    return this.#written(bundle.link, bundle.blobs());
  }
}

/** Makes a post that sends and receives with `store`, through `transports`. */
export async function loadPost(store: Store, { transports, validator, clock = Date.now }: PostOptions): Promise<Post> {
  const [inbound, outbound] = await Promise.all(
    (["Inbound", "Outbound"] as const).map((title) => encodeSchema(deliverySchema(title), validator)),
  );
  return new Post(store, transports, clock, { inbound: inbound!, outbound: outbound! });
}
