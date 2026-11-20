import type { EncodedObject, Link } from "@estoc/object";

/**
 * The transport's receiving side makes it, bound to a transport object and whatever it takes to
 * receive there, so a `Transport` stays the sending half alone.
 */
export interface Pickup {
  readonly transport: Link<EncodedObject>;
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
