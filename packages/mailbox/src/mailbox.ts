import { encodeBundle } from "@estoc/bundle";
import {
  type Bytes,
  decodeObject,
  type EncodedObject,
  objectFormat,
  type Schema,
  schemaOf,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { publicKeyFrom, seal } from "./key.ts";

/** One way of carrying ciphertexts to a mailbox, with the schema of its mailboxes. */
export interface Transport {
  /** The schema of this transport's mailboxes, made with `mailboxSchema`. */
  readonly schema: Schema<Value>;
  /**
   * Hands `ciphertext` on toward a mailbox whose data fits `schema`. Resolving says only that it
   * was handed on: nothing confirms that a message arrived, and none is sent again.
   *
   * @throws {UndeliveredMessage} when the ciphertext cannot be handed on.
   */
  deliver(mailbox: ValueMap, ciphertext: Uint8Array): Promise<void>;
}

/**
 * A ciphertext that a transport could not hand on toward a mailbox, with what the sender can do
 * about it.
 *
 * - `later`: the same can be sent again later, as when the network is down or the mailbox is full.
 * - `gone`: the mailbox takes nothing more, and another is needed.
 * - `refused`: the mailbox takes others but not this one, as when it is too large.
 */
export class UndeliveredMessage extends Error {
  override readonly name = "UndeliveredMessage";
  readonly kind: "later" | "gone" | "refused";

  constructor(kind: UndeliveredMessage["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

export interface Options {
  /** The transports whose mailboxes can be read; a mailbox of any other is refused. */
  readonly transports: readonly Transport[];
}

/**
 * A mailbox that has been read, bound to its key and its transport. It
 * shows neither, only lets a message be sent there.
 */
export class Mailbox {
  readonly #data: ValueMap;
  readonly #key: CryptoKey;
  readonly #transport: Transport;

  constructor(data: ValueMap, key: CryptoKey, transport: Transport) {
    this.#data = data;
    this.#key = key;
    this.#transport = transport;
  }

  /**
   * Sends the bundle of `root` and `blobs`, as `encodeBundle` writes it, sealed to the mailbox's key
   * and handed to the transport.
   *
   * @throws when `root` is not an object.
   * @throws {UndeliveredMessage} when the transport cannot hand the ciphertext on.
   */
  async send(root: { readonly bytes: Bytes<unknown> }, blobs: Iterable<Bytes<unknown>>): Promise<void> {
    await this.#transport.deliver(this.#data, await seal(this.#key, encodeBundle(root, blobs)));
  }
}

/**
 * Reads the bytes of a mailbox with the transport whose schema it is written to, and binds it once
 * to its key and that transport.
 *
 * @throws when no transport given takes the mailbox's schema, or its data does not fit that schema
 *   or holds no x25519 public key as `key`.
 */
export async function mailboxFrom(bytes: Bytes<EncodedObject<Value>>, { transports }: Options): Promise<Mailbox> {
  const { data, transport } = readMailbox(bytes, transports);
  return new Mailbox(data, await publicKeyFrom(data.key), transport);
}

/** A mailbox, its data with the key checked, and the transport whose schema it is written to. */
export function readMailbox(
  bytes: Bytes<EncodedObject<Value>>,
  transports: readonly Transport[],
): {
  readonly mailbox: EncodedObject<Value>;
  readonly data: ValueMap & { readonly key: Uint8Array };
  readonly transport: Transport;
} {
  const named = schemaOf(bytes, objectFormat);
  const transport = transports.find(({ schema }) => schema.link === named);
  if (transport === undefined) throw new Error(`no transport takes mailboxes written to ${named}`);
  const mailbox = decodeObject(bytes, transport.schema);
  const { data } = mailbox;
  // A transport may write its schema by hand, so the key every mailbox has is
  // checked here and not left to it.
  const { key } = data;
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("a mailbox's key is an x25519 public key, 32 bytes");
  }
  return { mailbox, data: { ...data, key }, transport };
}
