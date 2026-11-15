import type { Bytes, EncodedObject, Link } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { copiedBatch, leavesFirst } from "./batch.ts";
import { KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { type Store, StoreOf } from "./store.ts";

/** What one write puts in a private store. */
export interface MarkBatch {
  /**
   * Marks that the user of the private store writes: objects, of whatever type the caller holds
   * them as, of which only the bytes are written. The private store lists each as it is, with no
   * record of it.
   */
  readonly marks: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Blobs that come with them and are not listed, such as their schemas. Only those in the closure
   * of a mark are kept.
   */
  readonly blobs?: Iterable<Bytes<unknown>>;
}

/**
 * The marks a user keeps of what was done on their devices, such as when something was taken in:
 * objects that are listed as they are, kept apart from the store that bundles are gathered from.
 *
 * - It is kept beside a store, in a backend of its own, and reads that store too, so a mark can
 *   link to what the store holds.
 * - It lists the marks written to it and nothing else. An object of the schema of a mark that came
 *   to the store beside, as in a bundle, is read here by its link like any blob and is not a mark.
 * - A record, an object of `recordSchema`, is the mark that the user wrote an object that the store
 *   beside holds. A scan of an index over `selectedRecords` reads those objects from here, and one
 *   of an index over `selectedBlobs` reads the blobs of the store beside.
 * - A mark is kept here whether or not the store beside holds the same bytes, which anyone can
 *   send it. So the blob of every mark is in this backend, and what the store beside comes to hold
 *   changes neither what is listed here nor where it is kept.
 * - The store does not read it: a blob that only this keeps is not held by the store, so the store
 *   refuses to write anything with one in its closure, and neither its `get` nor its `closure`
 *   gives one.
 * - There is no `closure` here, and this is neither a `Store` nor a `SecretStore`, so it cannot be
 *   given to what gathers bundles from a store, nor to what keeps or reads a secret.
 * - It only grows, as a store does.
 */
export class PrivateStore implements RowKeeper {
  // Private fields make the type nominal, so neither a store nor a secret store can be given in
  // its place.
  readonly #backend: Backend;
  readonly #heldBlobs: Pick<Backend, "get" | "has">;
  readonly [rowsByIndex]: RowsByIndex;

  /**
   * Keeps what is written to it in `backend`, beside `store`.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  constructor(store: Store, backend: Backend) {
    this.#backend = backend;
    this.#heldBlobs = StoreOf.backendBeside(store, backend);
    this[rowsByIndex] = new KeptRows(this, {
      marks: (start) => backend.listedLinks(start),
      blobs: (start) => StoreOf.blobsOf(store, start),
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
    return blobIn(this.#heldBlobs, link);
  }

  /**
   * Keeps each of the batch's `marks` and lists it, with the blobs of the batch in its closure.
   * The other blobs are dropped. A refused batch writes nothing.
   *
   * - What the batch gives of a closure is kept here, whether or not the store beside holds it.
   * - A blob of a closure that the batch leaves out counts as held when either side holds it.
   * - A mark written again is listed once.
   *
   * @throws {RefusedBatch} when one of `marks` is not an object.
   * @throws {RefusedBatch} when a blob in the closure of one of `marks` is neither in the batch,
   *   kept here, nor held by the store beside.
   * @throws the backend's own error when the backend fails.
   */
  async write({ marks, blobs = [] }: MarkBatch): Promise<void> {
    const batch = copiedBatch(marks, blobs, "a mark");
    await this.#backend.put(await leavesFirst(batch.objects, batch.blobs, this.#heldBlobs), batch.objects);
  }

  /** The links of the marks, each once and in the order they were first written. */
  marks(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
  }
}
