import type { EncodedObject, Link } from "@estoc/object";

/**
 * The transport's receiving side makes it, bound to the mailbox and whatever it takes to receive
 * there, so a `Transport` stays the sending half alone.
 */
export interface Pickup {
  readonly mailbox: Link<EncodedObject>;
  /**
   * Ends once `signal` aborts, and, unless the transport waits for more to come, once nothing more
   * waits.
   */
  arrivals(signal?: AbortSignal): AsyncIterable<Arrival>;
}

export interface Arrival {
  readonly ciphertext: Uint8Array;
  drop(): Promise<void>;
}
