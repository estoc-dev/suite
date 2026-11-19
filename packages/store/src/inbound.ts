import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { MarkBatch, PrivateStore } from "./private-store.ts";
import { type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import type { StagedStore, Store } from "./store.ts";

/**
 * - `at` is in milliseconds since the Unix epoch, by the clock of the device that wrote the object.
 * - `via` is left out for what was handed over out of band.
 */
export const inboundSchema = schema("Inbound", {
  bundle: link<never>(),
  at: integer(),
  via: optional(link<EncodedObject>()),
});

export type InboundData = DataOf<typeof inboundSchema>;

export type InboundObject = EncodedObject<InboundData>;

export interface ReceivedBundle {
  readonly link: Link<never>;
  blobs(): Iterable<Bytes<unknown>>;
}

/**
 * - The mark says only that the bundle came in: a reader of it verifies what it reads itself.
 * - The bundle goes in the store first and the mark in the private store after, so a stop in
 *   between leaves a bundle that the store holds with no mark of it.
 * - That what comes from elsewhere goes through an intake is a rule for programs, which the stores
 *   do not enforce.
 */
export class Intake {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #clock: () => number;

  constructor(store: Store, privateStore: PrivateStore, clock: () => number = Date.now) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#clock = clock;
  }

  async receive(bundle: ReceivedBundle, via?: EncodedObject): Promise<InboundObject> {
    const { inbound, stagedStore } = await this.#arrivalOf(bundle, via);
    await stagedStore.commit();
    return inbound;
  }

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
    const mark = { marks: [inbound.link], blobs: [inbound.bytes, ...inboundSchema.blobs, ...viaBlobs] };
    const stagedBundle = await this.#store.stage({ roots: [bundle.link], blobs: bundle.blobs() });
    return { inbound, stagedStore: new StagedArrival(stagedBundle, this.#privateStore, mark) };
  }
}

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

  async commit(): Promise<void> {
    await this.#stagedBundle.commit();
    await this.#privateStore.write(this.#mark);
  }
}
