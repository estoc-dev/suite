import type { Bytes, Link, Reader } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { closureIn, copiedBlobs, leavesFirst } from "./batch.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";

export interface Batch {
  readonly roots: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * - Holding a blob says that it came in, and not whose it is: a mark that came in a bundle is held
 *   here like any blob and marks nothing, and what reads the blobs themselves reads a stranger's
 *   among them.
 * - There is no transaction that reads and then writes. Two devices that each find something
 *   missing will both write it, so what has to come out as one is written so that every device
 *   writes the same object, with the same link.
 */
export interface Store {
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  write(batch: Batch): Promise<void>;
  stage(batch: Batch): Promise<StagedStore>;
  /** A write cut short can leave a blob here that no root reaches. */
  blobs(): AsyncIterable<Link<unknown>>;
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
}

/**
 * - What is written to the store after the batch is staged shows here too, so a write in between,
 *   such as of an identity version that takes an agent out, can change what a view comes to.
 *   `commit` does not verify the batch again.
 * - A store only grows, so the batch can still be committed after other writes, and what it found
 *   held is still held.
 */
export interface StagedStore {
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
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

export const Store: new (backend: Backend) => Store = StoreOf;
