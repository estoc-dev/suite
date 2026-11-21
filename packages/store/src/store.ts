import type { Bytes, EncodedObject, Link, Reader } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { type Batch, closureIn, copiedBlobs, leavesFirst, refuseSecrets } from "./batch.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { isSecret, UnreadSecret } from "./secret-blob.ts";

/**
 * - Holding a blob says that it came in, and not whose it is: a mark that came in a bundle is held
 *   here like any blob and marks nothing, and what reads the blobs themselves reads a stranger's
 *   among them.
 * - A Secret is neither read, written nor listed among the blobs here, and a closure that reaches
 *   a Secret or a mark is refused, so what sends closures on sends neither.
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
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = await blobIn(this.#backend, link);
    if (bytes !== undefined && isSecret(bytes)) throw new UnreadSecret(link);
    return bytes;
  }

  async write(batch: Batch): Promise<void> {
    await (await this.stage(batch)).commit();
  }

  async stage({ roots, blobs }: Batch): Promise<StagedStore> {
    const keptBlobs = await leavesFirst(roots, copiedBlobs(blobs), this.#backend);
    refuseSecrets(keptBlobs);
    return new StagedStoreOf(this, this.#backend, keptBlobs);
  }

  async *blobs(): AsyncIterable<Link<unknown>> {
    for await (const link of this.#backend.blobs()) {
      const bytes = await this.#backend.get(link);
      if (bytes === undefined || !isSecret(bytes)) yield link;
    }
  }

  marks(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
  }

  async closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    const closureBlobs = await closureIn(this, link);
    const marks = await this[rowsByIndex].marks();
    for (const blob of closureBlobs.keys())
      if (marks.has(blob)) throw new Error(`the closure of ${link} reaches ${blob}, a mark, which stays in the store`);
    return closureBlobs;
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
