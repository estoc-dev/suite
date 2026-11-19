import { encodeBundle } from "@estoc/bundle";
import {
  type Bytes,
  decodeObject,
  type EncodedObject,
  type Link,
  type Schema,
  schemaOf,
  type ValueMap,
} from "@estoc/object";
import { publicKeyFrom, seal } from "./key.ts";

/**
 * A transport carries ciphertexts even where it encrypts on its own: a message is kept, passed on
 * and can arrive late, so the layer from end to end is the same whatever carries it.
 */
export interface Transport {
  readonly schema: Schema;
  /**
   * Resolving says only that the ciphertext was handed on: nothing confirms that a message arrived,
   * and none is sent again. It rejects with `UndeliveredMessage` when the ciphertext cannot be
   * handed on.
   */
  deliver(mailbox: ValueMap, ciphertext: Uint8Array): Promise<void>;
}

/**
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
  readonly transports: readonly Transport[];
}

export class Mailbox {
  readonly #data: ValueMap;
  readonly #key: CryptoKey;
  readonly #transport: Transport;

  constructor(data: ValueMap, key: CryptoKey, transport: Transport) {
    this.#data = data;
    this.#key = key;
    this.#transport = transport;
  }

  async send(root: Link<unknown>, blobs: Iterable<Bytes<unknown>>): Promise<void> {
    await this.#transport.deliver(this.#data, await seal(this.#key, encodeBundle(root, blobs)));
  }
}

export async function mailboxFrom(bytes: Bytes<EncodedObject>, { transports }: Options): Promise<Mailbox> {
  const { data, transport } = readMailbox(bytes, transports);
  return new Mailbox(data, await publicKeyFrom(data.key), transport);
}

export function readMailbox(
  bytes: Bytes<EncodedObject>,
  transports: readonly Transport[],
): {
  readonly mailbox: EncodedObject;
  readonly data: ValueMap & { readonly key: Uint8Array };
  readonly transport: Transport;
} {
  const named = schemaOf(bytes);
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
