import { decodeObject, schemaOf, type Json, type JsonObject, type Schema } from "@estoc/object";
import { hex } from "@scure/base";
// Temporal is not yet in every runtime this runs in, nor in the TypeScript lib.
import { Temporal } from "temporal-polyfill";
import { publicKeyFrom, seal } from "./key.ts";
import { encodeMessage, type Message } from "./message.ts";

/** One way of carrying sealed bytes to a mailbox, with the schema of its mailboxes. */
export interface Transport {
  /** The schema of this transport's mailboxes, made with `mailboxSchema`. */
  readonly schema: Schema;
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
  /** The reader's clock, which `until` is compared to; the system clock by default. */
  readonly clock?: () => Date;
}

type MailboxData = { readonly key?: Json; readonly until?: Json };

/**
 * A mailbox that has been read, bound to its key and its transport. It
 * shows neither, only lets a message be sent there.
 */
export class Mailbox {
  readonly #data: JsonObject;
  readonly #key: CryptoKey;
  readonly #until: Temporal.Instant | undefined;
  readonly #transport: Transport;
  readonly #clock: () => Date;

  constructor(data: JsonObject, key: CryptoKey, until: Temporal.Instant | undefined, transport: Transport, clock: () => Date) {
    this.#data = data;
    this.#key = key;
    this.#until = until;
    this.#transport = transport;
    this.#clock = clock;
  }

  /**
   * Seals `message` to the mailbox's key and hands it to the transport,
   * unless the mailbox has ended by the clock.
   */
  async send(message: Message): Promise<void> {
    checkInForce(this.#until, this.#clock());
    await this.#transport.deliver(this.#data, await seal(this.#key, encodeMessage(message)));
  }
}

/**
 * Reads the mailbox that is a message's entry, with the transport whose
 * schema it is written to, and binds it once: the key, the transport and
 * the end. Refuses a mailbox that has ended by the clock.
 */
export async function readMailbox(message: Message, { transports, clock = () => new Date() }: Options): Promise<Mailbox> {
  const named = schemaOf(message.entry);
  const transport = transports.find(({ schema }) => schema.link === named);
  if (transport === undefined) throw new Error(`no transport takes mailboxes written to ${named}`);
  const { data } = decodeObject(message.entry, transport.schema);
  // A transport may write its schema by hand, so the fields every mailbox
  // has are checked here and not left to it.
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("a mailbox is a JSON object");
  const { key, until } = data as MailboxData;
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) {
    throw new Error("a mailbox's key is an x25519 public key, 32 bytes in lowercase hex");
  }
  if (until !== undefined && typeof until !== "string") throw new Error("a mailbox's until is an RFC 3339 date-time");
  // Whether a validator asserts `format` is its own business, so an `until`
  // that Temporal does not read as an instant can reach here, and is refused.
  const end = until === undefined ? undefined : Temporal.Instant.from(until);
  checkInForce(end, clock());
  return new Mailbox(data as JsonObject, await publicKeyFrom(hex.decode(key)), end, transport, clock);
}

function checkInForce(until: Temporal.Instant | undefined, now: Date): void {
  if (until !== undefined && Temporal.Instant.compare(Temporal.Instant.fromEpochMilliseconds(now.getTime()), until) >= 0) {
    throw new Error(`the mailbox ended at ${until}`);
  }
}
