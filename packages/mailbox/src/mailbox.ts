import { writeBundle, zipBundle } from "@estoc/bundle";
import {
  decodeObject,
  json,
  schemaOf,
  type Bytes,
  type EncodedObject,
  type Encoding,
  type Json,
  type JsonObject,
  type Schema,
} from "@estoc/object";
import { hex } from "@scure/base";
import { publicKeyFrom, seal } from "./key.ts";

/** One way of carrying sealed bytes to a mailbox, with the schema of its mailboxes. */
export interface Transport {
  /** The schema of this transport's mailboxes, made with `mailboxSchema`. */
  readonly schema: Schema<Json>;
  /**
   * Hands sealed bytes on toward a mailbox whose data fits `schema`.
   * Resolving says only that they were handed on: nothing confirms that a
   * message arrived, and none is sent again. Rejects when they cannot be.
   */
  deliver(mailbox: JsonObject, sealed: Uint8Array): Promise<void>;
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
  readonly #data: JsonObject;
  readonly #key: CryptoKey;
  readonly #transport: Transport;

  constructor(data: JsonObject, key: CryptoKey, transport: Transport) {
    this.#data = data;
    this.#key = key;
    this.#transport = transport;
  }

  /**
   * Sends the bundle of `root` in `encoding` and `blobs`, as `writeBundle`
   * writes it: zipped without compression, sealed to the mailbox's key and
   * handed to the transport.
   */
  async send<D>(root: { readonly bytes: Bytes<unknown> }, blobs: Iterable<Bytes<unknown>>, encoding: Encoding<D>): Promise<void> {
    const zip = await zipBundle(writeBundle(root, blobs, encoding), { compress: false });
    await this.#transport.deliver(this.#data, await seal(this.#key, zip));
  }
}

/**
 * Reads the bytes of a mailbox with the transport whose schema it is written
 * to, and binds it once to its key and that transport.
 */
export async function mailboxFrom(bytes: Bytes<EncodedObject<Json>>, { transports }: Options): Promise<Mailbox> {
  const named = schemaOf(bytes, json);
  const transport = transports.find(({ schema }) => schema.link === named);
  if (transport === undefined) throw new Error(`no transport takes mailboxes written to ${named}`);
  const { data } = decodeObject(bytes, transport.schema);
  // A transport may write its schema by hand, so the key every mailbox has is
  // checked here and not left to it.
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("a mailbox is a JSON object");
  const { key } = data as { readonly key?: Json };
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) {
    throw new Error("a mailbox's key is an x25519 public key, 32 bytes in lowercase hex");
  }
  return new Mailbox(data as JsonObject, await publicKeyFrom(hex.decode(key)), transport);
}
