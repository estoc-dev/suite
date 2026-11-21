import type { Bytes, EncodedObject, Link, Reader } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { type Batch, closureIn, copiedBlobs, copiedMarks, leavesFirst, type MarkBatch } from "./batch.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";

/**
 * - Holding a blob says that it came in, and not whose it is: what reads the blobs themselves reads
 *   a stranger's among them. A mark is the user's own because `writeMarks` listed it, and `write`
 *   and `stage` list nothing, so an object of the schema of a mark that came in a bundle marks
 *   nothing.
 * - A store keeps no rule about who reads what. Packages are given the whole of it, Secrets and
 *   marks as well, and what shows a part of it to an app, or sends a closure to another party,
 *   leaves out or refuses what is not to go there.
 * - Marks are not signed, and `writeMarks` writes any mark, so it is no boundary between the
 *   programs that share a store.
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
  writeMarks(batch: MarkBatch): Promise<void>;
  /** A write cut short can leave a blob here that no root reaches. */
  blobs(): AsyncIterable<Link<unknown>>;
  /** In the order they were first written. */
  marks(): AsyncIterable<Link<EncodedObject>>;
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
    this[rowsByIndex] = new KeptRows(this, {
      marks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
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
    return new StagedStoreOf(this, this.#backend, await leavesFirst(roots, copiedBlobs(blobs), this.#backend));
  }

  async writeMarks({ marks, blobs }: MarkBatch): Promise<void> {
    const batch = copiedMarks(marks, blobs);
    await this.#backend.put(await leavesFirst(batch.marks, batch.blobs, this.#backend), batch.marks);
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  marks(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
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
