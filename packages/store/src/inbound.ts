import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { MarkBatch, Marks } from "./marks.ts";
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
 * - The bundle is written first and the mark after, so a stop in between leaves a bundle that the
 *   store holds with no mark of it.
 * - A bundle that holds a Secret is refused.
 * - That what comes from elsewhere goes through an intake is a rule for programs, which the store
 *   does not enforce.
 */
export class Intake {
  readonly #store: Store;
  readonly #marks: Marks;
  readonly #clock: () => number;

  constructor(store: Store, marks: Marks, clock: () => number = Date.now) {
    this.#store = store;
    this.#marks = marks;
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
    return { inbound, stagedStore: new StagedArrival(stagedBundle, this.#marks, mark) };
  }
}

class StagedArrival implements StagedStore, RowKeeper {
  readonly #stagedBundle: StagedStore;
  readonly #marks: Marks;
  readonly #mark: MarkBatch;

  constructor(stagedBundle: StagedStore, marks: Marks, mark: MarkBatch) {
    this.#stagedBundle = stagedBundle;
    this.#marks = marks;
    this.#mark = mark;
  }

  get [rowsByIndex](): RowsByIndex {
    // What a store stages keeps rows.
    return (this.#stagedBundle as StagedStore & RowKeeper)[rowsByIndex];
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#stagedBundle.get(link);
  }

  async commit(): Promise<void> {
    await this.#stagedBundle.commit();
    await this.#marks.write(this.#mark);
  }
}
