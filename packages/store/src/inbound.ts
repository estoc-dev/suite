import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { Batch, StagedStore, Store } from "./store.ts";

/**
 * The schema of an object that says a bundle came in from outside the store.
 *
 * - `bundle` is the link of the bundle's root.
 * - `at` is when, in milliseconds since the Unix epoch, by the clock of the device that wrote the
 *   object.
 * - `via` is the link of the channel it came in by, such as a mailbox, and is left out for what
 *   was handed over out of band. Which channel it is shows in the object it links to.
 */
export const inboundSchema = schema("Inbound", {
  bundle: link<never>(),
  at: integer(),
  via: optional(link<EncodedObject>()),
});

export type InboundData = DataOf<typeof inboundSchema>;

export type InboundObject = EncodedObject<InboundData>;

/** What `Intake` keeps: the link of a root and the blobs that come with it. A `Bundle` of `@estoc/bundle` is one. */
export interface ReceivedBundle {
  readonly link: Link<never>;
  blobs(): Iterable<Bytes<unknown>>;
}

/**
 * Keeps what comes from outside a store, and records an object of `inboundSchema` that says it
 * came in.
 *
 * - The object says that it came in and nothing more: the store holds the closure of its root, and
 *   `at` is by this device's clock.
 * - A reader of these objects verifies what it reads from them itself.
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
   * Keeps `bundle` and records an object that says it came in.
   *
   * - `via` is the object of the channel it came in by, when there is one. It and its schema go in
   *   the same write as the bundle and that object, whether or not the store held them.
   * - What comes in twice is recorded twice, once for each time it came in.
   *
   * @throws {RefusedBatch} when a blob in the closure of the bundle's root or of `via` is neither in
   *   that write nor held by the store; nothing is kept then.
   */
  async receive(bundle: ReceivedBundle, via?: EncodedObject): Promise<InboundObject> {
    const { inbound, batch } = this.#arrivalOf(bundle, via);
    await this.#store.write(batch);
    return inbound;
  }

  /**
   * The store as it will be once `bundle` is received, to read before keeping it.
   *
   * - `commit` keeps the bundle and records the object that says it came in, as `receive` does.
   * - `at` is the time the bundle was staged.
   *
   * @throws {RefusedBatch} for a bundle or a `via` that `receive` refuses, before anything reads it.
   */
  stage(bundle: ReceivedBundle, via?: EncodedObject): Promise<StagedStore> {
    return this.#store.stage(this.#arrivalOf(bundle, via).batch);
  }

  #arrivalOf(bundle: ReceivedBundle, via?: EncodedObject): { readonly inbound: InboundObject; readonly batch: Batch } {
    const data: InboundData = { bundle: new LinkValue(bundle.link), at: this.#clock() };
    const inbound = encodeObject(inboundSchema, via === undefined ? data : { ...data, via: new LinkValue(via.link) });
    const viaBlobs = via === undefined ? [] : [via.bytes, ...via.schema.blobs];
    return { inbound, batch: { records: [inbound], blobs: [...inboundSchema.blobs, ...viaBlobs, ...bundle.blobs()] } };
  }
}
