import type { Bytes, Link, Reader } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { closureIn, copiedBlobs, leavesFirst } from "./batch.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";

/** What one write puts in a store. */
export interface Batch {
  /**
   * Links of blobs that the store is to hold with their closures, such as an object that the user
   * wrote or the root of a bundle that came in. The store lists none of them, so a mark of what was
   * written goes in the private store beside.
   */
  readonly roots: Iterable<Link<unknown>>;
  /**
   * The blobs of the batch: the roots and what they link to. Only those in the closure of a root
   * are kept.
   */
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * The blobs that have come to a user, each with its closure, which bundles are gathered from.
 *
 * - Blobs are kept by link, whoever wrote them. A link names one blob wherever it is kept, and a
 *   store holds those that have come to it, so holding one says that it came in and not whose it
 *   is.
 * - A store lists its blobs and nothing else. What the user wrote and what came in from where are
 *   marked in the private store beside it, and what is not marked there is reached by following
 *   links from what is.
 * - A mark is a blob as well, which anyone can write. One that came in a bundle is held here like
 *   any blob and marks nothing.
 * - What reads the blobs themselves, from `blobs` or in an index over `selectedBlobs`, reads a
 *   stranger's among them. That is for showing what a store holds, and for objects that carry
 *   their authority in a signature.
 * - Every blob a store holds comes with its closure: the blob and every blob it links to, directly
 *   or through others.
 * - A write adds only the blobs in the closures of its roots.
 */
export interface Store {
  /**
   * A blob by its link.
   *
   * @throws when the backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * Puts in the blobs of the batch in the closures of its `roots`. The other blobs are dropped. A
   * refused batch writes nothing. A root that the store holds already need not be in the batch.
   *
   * @throws {RefusedBatch} when one of `roots`, or a blob in the closure of one, is neither in the
   *   batch nor held by the store, such as the schema of an object or a blob its data links to.
   * @throws the backend's own error when the backend fails.
   */
  write(batch: Batch): Promise<void>;
  /**
   * The store as it will be once `batch` is written, to read before writing it.
   *
   * - Of the batch's blobs, it keeps those that `write` would.
   * - `write(batch)` writes as `(await store.stage(batch)).commit()` does.
   *
   * @throws {RefusedBatch} for a batch that `write` refuses, before anything reads it.
   */
  stage(batch: Batch): Promise<StagedStore>;
  /**
   * The links of the blobs the store holds, each once and in the order it took them in, which a
   * later write leaves as it is. A blob is taken in once, by the first write that holds it, and
   * after the blobs it links to.
   *
   * - They are what the store has seen: an attachment as well as an object, and a stranger's as
   *   well as the user's. What the user wrote is what the records in the private store beside link
   *   to.
   * - A write cut short can leave one here that no root reaches.
   */
  blobs(): AsyncIterable<Link<unknown>>;
  /**
   * The closure of the blob that `link` names: the blob and every blob it links to, directly or
   * through others.
   *
   * - An object links to the blobs whose links it holds, its schema among them.
   * - Any other blob is bytes and links to nothing, such as an image, whatever links it seems to
   *   hold.
   *
   * @throws when the store does not hold a blob of the closure, the one `link` names among them.
   * @throws when the backend gives other bytes under a link in the closure.
   */
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
}

/**
 * A store as it will be once a batch is written, to read before the batch is written: the blobs
 * the store holds and those of the batch that `write` keeps.
 *
 * - The batch is fixed when it is staged, and the store is read as it is at each read, so what is
 *   written to the store afterwards shows here too.
 * - What a verifier or a view reads from it reads the same from the store once it is committed,
 *   when nothing else is written in between.
 * - A write in between, such as of an identity version that takes an agent out, can change what a
 *   view comes to when it is viewed again, here as on the store. `commit` does not verify the batch
 *   again.
 * - A store only grows, so the batch can still be committed after other writes, and what it found
 *   held is still held.
 */
export interface StagedStore {
  /**
   * A blob by its link, of the batch or held by the store, in an array the caller may change
   * without changing what `commit` writes.
   *
   * @throws as the store's `get` does.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /** Writes the batch as `write` writes it. Committing again writes nothing more. */
  commit(): Promise<void>;
}

export class StoreOf implements Store, RowKeeper {
  readonly #backend: Backend;
  readonly [rowsByIndex]: RowsByIndex;

  constructor(backend: Backend) {
    this.#backend = backend;
    this[rowsByIndex] = new KeptRows(this, { blobs: (start) => backend.blobs(start) });
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#backend, link);
  }

  async write(batch: Batch): Promise<void> {
    await (await this.stage(batch)).commit();
  }

  async stage({ roots, blobs }: Batch): Promise<StagedStore> {
    const keptBlobs = await leavesFirst(roots, copiedBlobs(blobs), this.#backend);
    return new StagedStoreOf(this, this.#backend, keptBlobs);
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  /**
   * A backend that keeps what is put in it in `backend` and holds besides all that `store` holds.
   * What `store` holds already is not put in `backend` again.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  static backendBeside(store: Store, backend: Backend): Backend {
    const sharedBackend = StoreOf.#backendOf(store);
    return {
      get: async (link) => (await backend.get(link)) ?? sharedBackend.get(link),
      has: async (link) => (await backend.has(link)) || sharedBackend.has(link),
      put: async (blobs, listedLinks) => {
        const ownBlobs = new Map<Link<unknown>, Uint8Array>();
        for (const [link, bytes] of blobs) if (!(await sharedBackend.has(link))) ownBlobs.set(link, bytes);
        await backend.put(ownBlobs, listedLinks);
      },
      listedLinks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    };
  }

  /**
   * The links of the blobs `store` holds, as its `blobs` gives them, leaving out the first `start`.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  static blobsOf(store: Store, start: number): AsyncIterable<Link<unknown>> {
    return StoreOf.#backendOf(store).blobs(start);
  }

  static #backendOf(store: Store): Backend {
    if (!(#backend in store)) throw new TypeError("only a store made by `new Store` has another kept beside it");
    return store.#backend;
  }

  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    return closureIn(this, link);
  }
}

class StagedStoreOf implements StagedStore, RowKeeper {
  readonly #store: Reader & RowKeeper;
  readonly #backend: Backend;
  readonly #blobs: ReadonlyMap<Link<unknown>, Uint8Array>;

  constructor(store: Reader & RowKeeper, backend: Backend, blobs: ReadonlyMap<Link<unknown>, Uint8Array>) {
    this.#store = store;
    this.#backend = backend;
    this.#blobs = blobs;
  }

  get [rowsByIndex](): RowsByIndex {
    return new AddedRows(this.#store[rowsByIndex], [...this.#blobs.keys()], this);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes === undefined ? this.#store.get(link) : new Uint8Array(bytes);
  }

  commit(): Promise<void> {
    return this.#backend.put(this.#blobs, []);
  }
}

/** Makes a store that keeps its blobs in `backend`. */
export const Store: new (backend: Backend) => Store = StoreOf;
