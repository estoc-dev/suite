import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { MarkBatch, PrivateStore } from "./private-store.ts";
import { type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import type { StagedStore, Store } from "./store.ts";

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
 * Keeps what comes from outside in a store, and marks that it came in with an object of
 * `inboundSchema` in the private store beside it.
 *
 * - The mark says that it came in and nothing more: the store holds the closure of its root, and
 *   `at` is by this device's clock.
 * - The bundle goes in the store first and the mark in the private store after, so a stop in
 *   between leaves a bundle that the store holds with no mark of it.
 * - A reader of these marks verifies what it reads from them itself.
 */
export class Intake {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #clock: () => number;

  /**
   * `privateStore` is the one kept beside `store`. `clock` gives the time in milliseconds since the
   * Unix epoch.
   */
  constructor(store: Store, privateStore: PrivateStore, clock: () => number = Date.now) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#clock = clock;
  }

  /**
   * Keeps `bundle` and marks that it came in.
   *
   * - `via` is the object of the channel it came in by, when there is one. It and its schema are
   *   kept with the mark in the private store, whether or not the store holds them.
   * - What comes in again is marked again, with the time it came in then. Two that agree on the
   *   bundle, `via` and the time by the clock are one mark, listed once.
   *
   * @throws {RefusedBatch} when a blob in the closure of the bundle's root is neither in the bundle
   *   nor held by the store; nothing is kept then.
   */
  async receive(bundle: ReceivedBundle, via?: EncodedObject): Promise<InboundObject> {
    const { inbound, stagedStore } = await this.#arrivalOf(bundle, via);
    await stagedStore.commit();
    return inbound;
  }

  /**
   * The store as it will be once `bundle` is received, to read before keeping it.
   *
   * - `commit` keeps the bundle and then marks that it came in, as `receive` does.
   * - It is the store alone that is staged: the mark is in the private store only once it is
   *   committed.
   * - `at` is the time the bundle was staged.
   *
   * @throws {RefusedBatch} for a bundle that `receive` refuses, before anything reads it.
   */
  async stage(bundle: ReceivedBundle, via?: EncodedObject): Promise<StagedStore> {
    return (await this.#arrivalOf(bundle, via)).stagedStore;
  }

  async #arrivalOf(
    bundle: ReceivedBundle,
    via?: EncodedObject,
  ): Promise<{ readonly inbound: InboundObject; readonly stagedStore: StagedStore }> {
    const data: InboundData = { bundle: new LinkValue(bundle.link), at: this.#clock() };
    const inbound = encodeObject(inboundSchema, via === undefined ? data : { ...data, via: new LinkValue(via.link) });
    const viaBlobs = via === undefined ? [] : [via.bytes, ...via.schema.blobs];
    const mark = { marks: [inbound], blobs: [...inboundSchema.blobs, ...viaBlobs] };
    const stagedBundle = await this.#store.stage({ roots: [bundle.link], blobs: bundle.blobs() });
    return { inbound, stagedStore: new StagedArrival(stagedBundle, this.#privateStore, mark) };
  }
}

/** A staged bundle whose `commit` goes on to mark in a private store that the bundle came in. */
class StagedArrival implements StagedStore, RowKeeper {
  readonly #stagedBundle: StagedStore;
  readonly #privateStore: PrivateStore;
  readonly #mark: MarkBatch;

  constructor(stagedBundle: StagedStore, privateStore: PrivateStore, mark: MarkBatch) {
    this.#stagedBundle = stagedBundle;
    this.#privateStore = privateStore;
    this.#mark = mark;
  }

  get [rowsByIndex](): RowsByIndex {
    // What a store stages keeps rows, and the private store is beside such a store.
    return (this.#stagedBundle as StagedStore & RowKeeper)[rowsByIndex];
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#stagedBundle.get(link);
  }

  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#stagedBundle.positionOf(link);
  }

  async commit(): Promise<void> {
    await this.#stagedBundle.commit();
    await this.#privateStore.write(this.#mark);
  }
}
