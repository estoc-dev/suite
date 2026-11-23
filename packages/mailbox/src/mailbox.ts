import { encodeBundle } from "@estoc/bundle";
import {
  AbsentBlob,
  type Bytes,
  decodeObject,
  type EncodedObject,
  type Link,
  type Reader,
  readObject,
  type Schema,
  schemaOf,
  type ValueMap,
} from "@estoc/object";
import { sendableBlobs } from "@estoc/store";
import { publicKeyFrom, seal } from "./key.ts";
import { type MailboxData, mailboxSchema } from "./schema.ts";

/**
 * A transport carries ciphertexts even where it encrypts on its own: a message is kept, passed on
 * and can arrive late, so the layer from end to end is the same whatever carries it.
 */
export interface Transport<F extends ValueMap = ValueMap> {
  readonly schema: Schema<F>;
  /**
   * Throws `UndeliveredMessage` when the transport object names a place that no route reaches, so
   * that a sender turns back that mailbox alone.
   */
  routeTo(transport: F): Route;
}

export interface Route {
  /**
   * Resolving says only that the ciphertext was handed on: nothing confirms that a message arrived,
   * and none is sent again. It rejects with `UndeliveredMessage` when the ciphertext cannot be
   * handed on.
   */
  deliver(ciphertext: Uint8Array<ArrayBuffer>): Promise<void>;
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
  readonly link: Link<EncodedObject<MailboxData>>;
  readonly #key: CryptoKey;
  readonly #route: Route;

  constructor(link: Link<EncodedObject<MailboxData>>, key: CryptoKey, route: Route) {
    this.link = link;
    this.#key = key;
    this.#route = route;
  }

  async send(root: Link<unknown>, blobs: Iterable<Bytes<unknown>>): Promise<void> {
    await this.#route.deliver(await seal(this.#key, encodeBundle(root, sendableBlobs(blobs))));
  }
}

/**
 * A mailbox whose transport is not given is out of reach as much as one that its transport has no
 * route to, so it too is turned back as gone, and a sender goes on to the others it is given.
 */
export async function mailboxAt(
  link: Link<EncodedObject<MailboxData>>,
  reader: Reader,
  { transports }: Options,
): Promise<Mailbox> {
  const { data } = await readObject(reader, link, mailboxSchema);
  if (data.key.length !== 32) throw new Error("a mailbox's key is an x25519 public key, 32 bytes");
  const transportLink = data.transport.link;
  const bytes = await reader.get(transportLink);
  if (bytes === undefined) throw new AbsentBlob(transportLink);
  const named = schemaOf(bytes);
  const transport = transports.find(({ schema }) => schema.link === named);
  if (transport === undefined) throw new UndeliveredMessage("gone", `no transport given takes ${named}`);
  const route = transport.routeTo(decodeObject(bytes, transport.schema).data);
  return new Mailbox(link, await publicKeyFrom(data.key), route);
}
