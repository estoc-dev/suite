import type { Bytes, Link } from "@estoc/object";
import type { Backend } from "./backend.ts";
import type { RecordObject } from "./record.ts";
import { type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { type Batch, type Store, StoreOf } from "./store.ts";

/**
 * What the user keeps to themselves: objects they write and the blobs in their closures, kept
 * apart from the store that bundles are gathered from.
 *
 * - It is kept beside a store, in a backend of its own, and reads that store too, so what is kept
 *   here can link to what the store holds.
 * - The store does not read it: a blob that only this keeps is not held by the store, so the store
 *   refuses to write anything with one in its closure, and neither its `get` nor its `closure`
 *   gives one.
 * - There is no `closure` here, and this is not a `Store`, so it cannot be given to what gathers
 *   bundles from a store.
 * - Bytes that are also written to the store are the store's as well.
 * - Whether what is kept here is encrypted is up to the backend.
 */
export class SecretStore {
  // A private field makes the type nominal, unlike the interface `Store`, so a
  // store, which has every method of this one, cannot be given in its place.
  readonly #store: Store & RowKeeper;

  /**
   * Keeps what is written to it in `backend`, beside `store`.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  constructor(store: Store, backend: Backend) {
    this.#store = new StoreOf(StoreOf.backendBeside(store, backend));
  }

  /**
   * A blob by its link, kept here or held by the store beside.
   *
   * @throws when a backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#store.get(link);
  }

  /**
   * Records each of the batch's `records` here, as a store writes them. A blob of a closure that
   * the store beside holds counts as held and is not kept here again, a record among them.
   */
  write(batch: Batch): Promise<void> {
    return this.#store.write(batch);
  }

  /** The links of the records listed here, each once, in no particular order, as a store's `records` gives them. */
  records(): AsyncIterable<Link<RecordObject>> {
    return this.#store.records();
  }

  /**
   * The links of the blobs kept here, each once and in the order they were kept, as a store's
   * `blobs` gives them. A blob that only the store beside holds was not kept here, and is not
   * among them.
   */
  blobs(): AsyncIterable<Link<unknown>> {
    return this.#store.blobs();
  }

  /**
   * How many blobs were kept here before the one of `link`, as a store's `positionOf` gives it. A
   * blob that only the store beside holds was not kept here, and has none.
   */
  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#store.positionOf(link);
  }

  get [rowsByIndex](): RowsByIndex {
    return this.#store[rowsByIndex];
  }
}
