import type { Bytes, EncodedObject, Link, Reader, ValueMap } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import {
  type Batch,
  closureIn,
  hashedBatchWith,
  hashedBlobs,
  leavesFirst,
  type RecordBatch,
  recordsOf,
} from "./batch.ts";
import { KeptRows, rowsWithAdded, type ScanOptions, scannedRows } from "./scan.ts";
import type { Rows } from "./sorted-rows.ts";
import type { FieldNames, OrderedIndex } from "./source.ts";

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
  /**
   * - A store keeps the rows of each index it is scanned for, so a later scan reads only what was
   *   put since.
   * - What a source of the index or its `rows` throw on gives no rows of that source, is listed in
   *   the `failures` of the rows, and is not read again.
   * - Where the index reads blobs, failures do not throw unless asked to: anyone can send a blob that
   *   it fails on, and that would otherwise stop the other rows from being read.
   * - When the store throws, or gives no blob, for a link that is read, the scan throws even where a
   *   selection or its rows catch it. That is not listed in the `failures`, and a later scan reads
   *   the link again.
   */
  scan<F extends ValueMap, By extends FieldNames<F>>(
    index: OrderedIndex<F, By>,
    options?: ScanOptions,
  ): Promise<Rows<F, By>>;
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
  /**
   * The rows and their failures come of the blobs the store holds at the scan together with those
   * of the batch. No Record is staged, so the batch adds nothing to what is recorded.
   */
  scan<F extends ValueMap, By extends FieldNames<F>>(
    index: OrderedIndex<F, By>,
    options?: ScanOptions,
  ): Promise<Rows<F, By>>;
}

export class StoreOf implements Store {
  readonly #backend: Backend;
  readonly #keptRows: KeptRows;

  constructor(backend: Backend) {
    this.#backend = backend;
    this.#keptRows = new KeptRows(this, (start) => backend.blobs(start));
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
    const hashedBatch = { blobs: hashedBlobs(blobs), records: [] };
    const stagedBlobs = await leavesFirst(roots, hashedBatch, this.#backend);
    return new StagedStoreOf(this, this.#keptRows, this.#backend, stagedBlobs);
  }

  async record({ statements, blobs }: RecordBatch): Promise<void> {
    const givenBlobs = hashedBlobs(blobs);
    const hashedBatch = hashedBatchWith(recordsOf(statements, givenBlobs), givenBlobs);
    // Each Record goes after the closure of its statement, so a write cut short keeps no Record of
    // a statement the store does not hold whole.
    await this.#backend.put(await leavesFirst(hashedBatch.records, hashedBatch, this.#backend));
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  async *records(): AsyncIterable<Link<EncodedObject>> {
    yield* (await this.recordedStatements()).statements;
  }

  recordedStatements(): Promise<RecordedStatements> {
    return this.#keptRows.read(async (rows) => ({
      statements: (await rows.records()).links,
      blobCount: rows.blobCount,
    }));
  }

  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    return closureIn(this, link);
  }

  scan<F extends ValueMap, By extends FieldNames<F>>(
    index: OrderedIndex<F, By>,
    options?: ScanOptions,
  ): Promise<Rows<F, By>> {
    return this.#keptRows.read((rows) => scannedRows(rows, index, options));
  }
}

class StagedStoreOf implements StagedStore {
  readonly #store: Reader;
  readonly #keptRows: KeptRows;
  readonly #backend: Backend;
  readonly #blobs: ReadonlyMap<Link<unknown>, Uint8Array>;

  constructor(store: Reader, keptRows: KeptRows, backend: Backend, blobs: ReadonlyMap<Link<unknown>, Uint8Array>) {
    this.#store = store;
    this.#keptRows = keptRows;
    this.#backend = backend;
    this.#blobs = blobs;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#blobs.get(link) ?? this.#store.get(link);
  }

  commit(): Promise<void> {
    return this.#backend.put(this.#blobs);
  }

  scan<F extends ValueMap, By extends FieldNames<F>>(
    index: OrderedIndex<F, By>,
    options?: ScanOptions,
  ): Promise<Rows<F, By>> {
    return this.#keptRows.read(async (rows) =>
      scannedRows(await rowsWithAdded(rows, [...this.#blobs.keys()], this), index, options),
    );
  }
}

export const Store: new (backend: Backend) => Store = StoreOf;
