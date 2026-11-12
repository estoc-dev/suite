import type { EncodedObject, Link, Value } from "@estoc/object";

/**
 * What waits at one mailbox, as its transport hands it to the receiver. The
 * transport's receiving side makes it, bound to the mailbox and whatever it
 * takes to receive there, so a `Transport` stays the sending half alone.
 */
export interface Pickup {
  /** The link of the mailbox that what waits was sent to. */
  readonly mailbox: Link<EncodedObject<Value>>;
  /**
   * What waits, each until it is done. Ends once `signal` aborts, and,
   * unless the transport waits for more to come, once nothing more waits.
   */
  arrivals(signal?: AbortSignal): AsyncIterable<Arrival>;
}

/** A ciphertext that waits at a mailbox until the receiver is done with it. */
export interface Arrival {
  readonly ciphertext: Uint8Array;
  /** Lets the transport drop the ciphertext, which then no longer waits. */
  drop(): Promise<void>;
}
