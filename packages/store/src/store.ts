import type { Bytes, EncodedObject, Link, Reader } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import {
  type Batch,
  closureIn,
  copiedBatchWith,
  copiedBlobs,
  leavesFirst,
  type RecordBatch,
  recordsOf,
} from "./batch.ts";
import { KeptRows, type RowKeeper, type RowsByIndex, readRows, rowsWithAdded } from "./scan.ts";

/**
 * - Holding a blob says that it came in, and not whose it is: what reads the blobs themselves reads
 *   a stranger's among them. A statement is the store's own where a Record links to it, and only
 *   `record` writes a Record: every batch that gives one, or that links to one, is refused, so a
 *   statement of the same schema that came in a bundle records nothing.
 * - A store keeps no rule about who reads what. Packages are given the whole of it, Secrets and
 *   Records as well, and what shows a part of it to an app, or sends a closure to another party,
 *   leaves out or refuses what is not to go there.
 * - Records are not signed, and `record` records any statement, so it is no boundary between the
 *   programs that share a store. A program records what it composed itself, and puts an object
 *   that came from elsewhere inside a statement of its own; the store does not enforce it.
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
  record(batch: RecordBatch): Promise<void>;
  /** A write cut short can leave a blob here that no root reaches. */
  blobs(): AsyncIterable<Link<unknown>>;
  /** The statements recorded, in the order their Records were first written. It reads every blob held. */
  records(): AsyncIterable<Link<EncodedObject>>;
  recordedStatements(): Promise<RecordedStatements>;
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
}

export interface RecordedStatements {
  /** In the order their Records were first written. */
  readonly statements: readonly Link<EncodedObject>[];
  /**
   * How many blobs the store held when the statements were read. A store only grows and its records
   * come of the blobs held alone, so the statements read while it holds as many are these.
   */
  readonly blobCount: number;
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
  readonly #keptRows: KeptRows;

  constructor(backend: Backend) {
    this.#backend = backend;
    this.#keptRows = new KeptRows(this, (start) => backend.blobs(start));
  }

  [readRows]<T>(use: (rows: RowsByIndex) => Promise<T>): Promise<T> {
    return this.#keptRows.read(use);
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
    const copiedBatch = { blobs: copiedBlobs(blobs), records: [] };
    return new StagedStoreOf(this, this.#backend, await leavesFirst(roots, copiedBatch, this.#backend));
  }

  async record({ statements, blobs }: RecordBatch): Promise<void> {
    const givenBlobs = copiedBlobs(blobs);
    const copiedBatch = copiedBatchWith(recordsOf(statements, givenBlobs), givenBlobs);
    // Each Record goes after the closure of its statement, so a write cut short keeps no Record of
    // a statement the store does not hold whole.
    await this.#backend.put(await leavesFirst(copiedBatch.records, copiedBatch, this.#backend));
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  async *records(): AsyncIterable<Link<EncodedObject>> {
    yield* (await this.recordedStatements()).statements;
  }

  recordedStatements(): Promise<RecordedStatements> {
    return this[readRows](async (rows) => ({ statements: (await rows.records()).links, blobCount: rows.blobCount }));
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

  [readRows]<T>(use: (rows: RowsByIndex) => Promise<T>): Promise<T> {
    return this.#store[readRows](async (rows) => use(await rowsWithAdded(rows, [...this.#blobs.keys()], this)));
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes === undefined ? this.#store.get(link) : new Uint8Array(bytes);
  }

  commit(): Promise<void> {
    return this.#backend.put(this.#blobs);
  }
}

export const Store: new (backend: Backend) => Store = StoreOf;
