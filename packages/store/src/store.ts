import { type Bytes, type EncodedObject, type Link, type Reader, readObject, type ValueMap } from "@estoc/object";
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
import { derivationOf, type Index } from "./collection.ts";
import { collectionSchema, membersOf } from "./collection-object.ts";
import { blobSetOf, KeptRows, recordedStatementsIn } from "./scan.ts";
import type { Rows } from "./sorted-rows.ts";

export interface Scannable {
  /**
   * - A blob that a part of the index throws on gives no rows of that part, and is listed in the
   *   `failures` of the rows.
   * - A failure does not make the scan throw: anyone can send a blob that an index fails on, and
   *   that would stop the other rows from being read. What needs every row looks at the `failures`.
   * - When the store throws, or gives no blob, for a link that is read, the scan throws even where
   *   the `rows` of the index catch it. That is not listed in the `failures`.
   */
  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>>;
}

/**
 * - Holding a blob says that it came in, and not whose it is: what reads the blobs themselves reads
 *   a stranger's among them. A statement is the store's own where a Record links to it, and only
 *   `record` writes a Record: every batch that gives one is refused, so a statement of the same
 *   schema that came in a bundle records nothing.
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
export interface Store extends Scannable {
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
   * - An index scanned over the collection gives the rows and the failures that it gives of the
   *   members in the store, and none of any other blob held. Each member is read with its closure,
   *   which the store holds; a blob that is in a closure and is not a member is not read for rows of
   *   its own.
   * - What is recorded in a collection is what the Records among its members link to, which the
   *   store wrote as it did every Record it holds. A statement that the store recorded gives no row
   *   of what an index reads from the records unless its Record is a member, whether or not the
   *   statement is one itself.
   * - The rows are worked out at each scan, and none is kept for the next.
   */
  heldCollection(link: Link<unknown>): Promise<Scannable>;
  /**
   * A store keeps the rows of each index it is scanned for, and what the index failed on, so a
   * later scan reads only what was put since the last scan for it that gave rows.
   */
  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>>;
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
export interface StagedStore extends Scannable {
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  commit(): Promise<void>;
  /**
   * The rows and their failures come of the blobs the store holds at the scan together with the
   * closures of the roots of the batch. No Record is staged, so the batch adds nothing to what is
   * recorded.
   */
  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>>;
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
    const stagedBlobs = await leavesFirst(roots, hashedBlobs(blobs), this.#backend);
    return new StagedStoreOf(this, this.#keptRows, this.#backend, stagedBlobs);
  }

  async record({ statements, blobs }: RecordBatch): Promise<void> {
    const givenBlobs = hashedBlobs(blobs);
    const hashedBatch = hashedBatchWith(recordsOf(statements, givenBlobs), givenBlobs);
    // Each Record goes after the closure of its statement, so a write cut short keeps no Record of
    // a statement the store does not hold whole.
    await this.#backend.put(await leavesFirst(hashedBatch.records, hashedBatch.blobs, this.#backend));
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  async *records(): AsyncIterable<Link<EncodedObject>> {
    yield* (await this.recordedStatements()).statements;
  }

  recordedStatements(): Promise<RecordedStatements> {
    return this.#keptRows.read(async (blobSet) => ({
      statements: await recordedStatementsIn(blobSet),
      blobCount: blobSet.blobCount,
    }));
  }

  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    return closureIn(this, link);
  }

  async heldCollection(link: Link<unknown>): Promise<Scannable> {
    const members = membersOf(await readObject(this, link, collectionSchema));
    // A blob set keeps what it has worked out, a failure of the store to read as well, so each scan
    // is given a new one.
    return { scan: (index) => blobSetOf(members, this).rowsOf(derivationOf(index)) };
  }

  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>> {
    return this.#keptRows.read((blobSet) => blobSet.rowsOf(derivationOf(index)));
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

  scan<F extends ValueMap>(index: Index<F>): Promise<Rows<F>> {
    return this.#keptRows.read(async (blobSet) =>
      (await blobSet.adding([...this.#blobs.keys()], this)).rowsOf(derivationOf(index)),
    );
  }
}

export const Store: new (backend: Backend) => Store = StoreOf;
