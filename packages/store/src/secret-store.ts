import type { Bytes, EncodedObject, Link } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { copiedBatch, leavesFirst } from "./batch.ts";
import { KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { type Store, StoreOf } from "./store.ts";

/** What one write puts in a secret store. */
export interface SecretBatch {
  /**
   * The links of the secrets that the user of the secret store writes: objects, which the secret
   * store lists as they are.
   */
  readonly secrets: Iterable<Link<unknown>>;
  /**
   * The blobs of the batch: the secrets, and what comes with them and is not listed, such as their
   * schemas. Only those in the closure of a secret are kept.
   */
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * What the user keeps on one device: secrets, objects that are listed as they are, and the blobs in
 * their closures, kept apart from the store that bundles are gathered from.
 *
 * - It is kept beside a store, in a backend of its own, and reads that store too, so what is kept
 *   here can link to what the store holds.
 * - It lists the secrets written to it and nothing else. An object of the schema of a secret that
 *   came to the store beside, as in a bundle, is read here by its link like any blob and is not
 *   listed.
 * - The store does not read it: a blob that only this keeps is not held by the store, so the store
 *   refuses to write anything with one in its closure, and neither its `get` nor its `closure`
 *   gives one.
 * - There is no `closure` here, and this is neither a `Store` nor a `PrivateStore`, so it cannot be
 *   given to what gathers bundles from a store, nor to what keeps marks.
 * - Bytes that are also written to the store are the store's as well: a blob that the store beside
 *   holds is not kept here again.
 * - Whether what is kept here is encrypted is up to the backend.
 */
export class SecretStore implements RowKeeper {
  // A private field makes the type nominal, so neither a store nor a private store can be given in
  // its place.
  readonly #backend: Backend;
  readonly [rowsByIndex]: RowsByIndex;

  /**
   * Keeps what is written to it in `backend`, beside `store`.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  constructor(store: Store, backend: Backend) {
    this.#backend = StoreOf.backendBeside(store, backend);
    this[rowsByIndex] = new KeptRows(this, {
      secrets: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
  }

  /**
   * A blob by its link, kept here or held by the store beside.
   *
   * @throws when a backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#backend, link);
  }

  /**
   * Lists each of the batch's `secrets` and keeps it, with the blobs of the batch in its closure.
   * The other blobs are dropped. A refused batch writes nothing.
   *
   * - The batch gives the blob of each secret, held already or not. Any other blob of a closure
   *   that it leaves out counts as held when either side holds it.
   * - A blob that the store beside holds is not kept here again, a secret among them, which is
   *   listed here still.
   * - A secret written again is listed once.
   *
   * @throws {RefusedBatch} when the batch does not give the blob of one of `secrets`, or it is
   *   not an object.
   * @throws {RefusedBatch} when a blob in the closure of one of `secrets` is neither in the batch,
   *   kept here, nor held by the store beside.
   * @throws the backend's own error when the backend fails.
   */
  async write({ secrets, blobs }: SecretBatch): Promise<void> {
    const batch = copiedBatch(secrets, blobs, "a secret");
    await this.#backend.put(await leavesFirst(batch.objects, batch.blobs, this.#backend), batch.objects);
  }

  /** The links of the secrets, each once and in the order they were first written. */
  secrets(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
  }

  /**
   * The links of the blobs kept here, each once and in the order they were kept. A blob that only
   * the store beside holds was not kept here, and is not among them.
   */
  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }
}
