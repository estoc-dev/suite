import {
  type Bytes,
  blobsOf,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { RecordBatch } from "./batch.ts";
import type { Rows } from "./sorted-rows.ts";
import type { Index } from "./source.ts";
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
 * - The Inbound says only that the bundle came in: a reader of it verifies what it reads itself.
 * - The bundle is written first and the Inbound recorded after, so a stop in between leaves a
 *   bundle that the store holds with no record of it.
 * - That what comes from elsewhere goes through an intake is a rule for programs, which the store
 *   does not enforce.
 */
export class Intake {
  readonly #store: Store;
  readonly #clock: () => number;

  constructor(store: Store, clock: () => number = Date.now) {
    this.#store = store;
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
    const viaBlobs = via === undefined ? [] : blobsOf(via);
    const record = { statements: [inbound.link], blobs: [...blobsOf(inbound), ...viaBlobs] };
    const stagedBundle = await this.#store.stage({ roots: [bundle.link], blobs: bundle.blobs() });
    return { inbound, stagedStore: new StagedArrival(stagedBundle, this.#store, record) };
  }
}

class StagedArrival implements StagedStore {
  readonly #stagedBundle: StagedStore;
  readonly #store: Store;
  readonly #record: RecordBatch;

  constructor(stagedBundle: StagedStore, store: Store, record: RecordBatch) {
    this.#stagedBundle = stagedBundle;
    this.#store = store;
    this.#record = record;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#stagedBundle.get(link);
  }

  async commit(): Promise<void> {
    await this.#stagedBundle.commit();
    await this.#store.record(this.#record);
  }

  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>> {
    return this.#stagedBundle.scan(index);
  }
}
