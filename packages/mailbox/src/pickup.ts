import type { EncodedObject, Link } from "@estoc/object";
import type { MailboxData } from "./schema.ts";

/**
 * The transport's receiving side makes it, bound to a mailbox and whatever it takes to receive
 * there, so a `Transport` stays the sending half alone. It picks up at a queue that no other
 * mailbox is delivered to, since an inbox is done with whatever does not open with its key.
 */
export interface Pickup {
  readonly mailbox: Link<EncodedObject<MailboxData>>;
  /**
   * Ends once `signal` aborts, and, unless the transport waits for more to come, once nothing more
   * waits. An arrival handed out stays until it is dropped, so one that the receiver fails to keep
   * comes again on a later call.
   */
  arrivals(signal?: AbortSignal): AsyncIterable<Arrival>;
}

export interface Arrival {
  readonly ciphertext: Uint8Array;
  drop(): Promise<void>;
}
