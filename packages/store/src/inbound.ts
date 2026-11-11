import { type Bytes, type EncodedObject, encodeObject, type Json, type Link } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { Store } from "./store.ts";

/**
 * The schema of a record that a bundle came in from outside the store.
 *
 * - `bundle` is the link of the bundle's root.
 * - `at` is when, in milliseconds since the Unix epoch, by the clock of the device that wrote the
 *   record.
 * - `via` is the link of the channel it came in by, such as a mailbox, and is left out for what
 *   was handed over out of band. Which channel it is shows in the object it links to.
 */
export const inboundSchema = await schema("Inbound", {
  bundle: link<never>(),
  at: integer(),
  via: optional(link<EncodedObject<Json>>()),
});

export type InboundData = DataOf<typeof inboundSchema>;

export type InboundObject = EncodedObject<Json, InboundData>;

/** What `Intake` keeps: the link of a root and the blobs that come with it. A `Bundle` of `@estoc/bundle` is one. */
export interface ReceivedBundle {
  readonly link: Link<never>;
  blobs(): Iterable<Bytes<unknown>>;
}

/**
 * Keeps what comes from outside a store, with a record of `inboundSchema` that it came in.
 *
 * - The record says that it came in and nothing more: the store holds the closure of its root, and
 *   `at` is by this device's clock.
 * - A reader of the records verifies what it reads from them itself.
 */
export class Intake {
  readonly #store: Store;
  readonly #clock: () => number;

  /** `clock` gives the time in milliseconds since the Unix epoch. */
  constructor(store: Store, clock: () => number = Date.now) {
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * Keeps `bundle` with a record that it came in.
   *
   * - `via` is the object of the channel it came in by, when there is one. It and its schema go in
   *   the same write as the bundle and the record, whether or not the store held them.
   * - What comes in twice is recorded twice, once for each time it came in.
   *
   * @throws {RefusedBatch} when a blob in the closure of the bundle's root or of `via` is neither in
   *   that write nor held by the store; nothing is kept then.
   */
  async receive(bundle: ReceivedBundle, via?: EncodedObject<Json>): Promise<InboundObject> {
    const data: InboundData = { bundle: { $link: bundle.link }, at: this.#clock() };
    const record = encodeObject(inboundSchema, via === undefined ? data : { ...data, via: { $link: via.link } });
    const viaBlobs = via === undefined ? [] : [via.bytes, ...via.schema.blobs];
    await this.#store.write({ records: [record], blobs: [...inboundSchema.blobs, ...viaBlobs, ...bundle.blobs()] });
    return record;
  }
}
