import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue, linkOf } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { copiedBatch, leavesFirst, linksIn } from "./batch.ts";
import { type RecordObject, recordSchema } from "./record.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";

/** What one write puts in a store. */
export interface Batch {
  /**
   * Objects that the user of the store writes, of whatever type the caller holds them as: only
   * their bytes are written. The store records each: it writes a record, an object of
   * `recordSchema` that links to the object, and lists the record.
   */
  readonly records?: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Links of blobs that the store is to hold with their closures, such as the root of a bundle
   * that came in. The store lists none of them, so a mark of what was written goes in a private
   * store beside.
   */
  readonly roots?: Iterable<Link<unknown>>;
  /**
   * Blobs that come with them and are not recorded: what the objects and the roots link to, and
   * the roots themselves. Only those in the closure of a recorded object or of a root are kept.
   */
  readonly blobs?: Iterable<Bytes<unknown>>;
}

/**
 * The objects a user writes and the blobs that come with them.
 *
 * - Blobs are kept by link, whoever wrote them. A link names one blob wherever it is kept, and a
 *   store holds those that have come to it, so holding one says that it came in and not whose it
 *   is.
 * - A record marks an object that the user wrote: it is an object of `recordSchema` that links to
 *   that object, and the store lists it. Anything else is reached by following links from the
 *   recorded objects, so an object that someone else slipped into a bundle is read only as part of
 *   what it came with.
 * - A record is a blob as well, which anyone can write. One that came in a bundle is held and not
 *   listed, so it records nothing here.
 * - What reads the blobs themselves, from `blobs` or in an index over `selectedBlobs`, reads a
 *   stranger's among them. That is for showing what a store holds, and for objects that carry
 *   their authority in a signature.
 * - Every blob a store holds comes with its closure: the blob and every blob it links to, directly
 *   or through others.
 * - A write adds only the blobs in the closures of its records and of its roots.
 * - A store keeps the order it took its blobs in, which a later write leaves as it is, so a reader
 *   can tell what it held when a blob came in.
 */
export interface Store {
  /**
   * A blob by its link, recorded or not.
   *
   * @throws when the backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * Puts in the blobs of the batch in the closures of its `roots` and of its `records`. The other
   * blobs are dropped. A refused batch writes nothing.
   *
   * - Each of `records` is recorded: a record of it is put in with the blobs in the record's
   *   closure, the object among them, and is listed.
   * - A root is not listed. One that the store holds already need not be in the batch.
   *
   * @throws {RefusedBatch} when one of `records` is not an object.
   * @throws {RefusedBatch} when one of `roots`, or a blob in the closure of one of `roots` or of
   *   `records`, is neither in the batch nor held by the store, such as the schema of an object or
   *   a blob its data links to.
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
   * The links of the records, each once, in no particular order. The `object` of a record is the
   * link of the object it records.
   */
  records(): AsyncIterable<Link<RecordObject>>;
  /**
   * The links of the blobs the store holds, recorded or not, each once and in the order it took
   * them in, so `positionOf` gives where each is among them.
   *
   * - They are what the store has seen: an attachment as well as an object, and a stranger's as
   *   well as the user's. What the user wrote is what the records link to.
   * - A write cut short can leave one here that no record reaches.
   */
  blobs(): AsyncIterable<Link<unknown>>;
  /**
   * How many blobs the store had taken in before the one of `link`, or `undefined` when it holds
   * none. A blob is taken in once, by the first write that holds it, and after the blobs it links
   * to.
   */
  positionOf(link: Link<unknown>): Promise<number | undefined>;
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
 * the store holds and those of the batch that `write` keeps, and the store's records with the
 * batch's.
 *
 * - The batch is fixed when it is staged, and the store is read as it is at each read, so what is
 *   written to the store afterwards shows here too.
 * - What a verifier or a view reads from it reads the same from the store once it is committed,
 *   when nothing else is written in between, apart from what depends on the order the store took
 *   blobs in: here a blob that only the batch holds comes in now, and `commit` takes the batch's
 *   blobs in one after another.
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
  /**
   * The links of the store's records and of the batch's, each once, in no particular order. Those
   * of the batch are listed here before anything has verified what they record.
   */
  records(): AsyncIterable<Link<RecordObject>>;
  /**
   * Where the store took in the blob of `link`, as its `positionOf` gives it. The batch is taken in
   * only once it is committed, so a blob of the batch that the store does not hold has none until
   * then.
   */
  positionOf(link: Link<unknown>): Promise<number | undefined>;
  /** Writes the batch as `write` writes it. Committing again writes nothing more. */
  commit(): Promise<void>;
}

export class StoreOf implements Store, RowKeeper {
  readonly #backend: Backend;
  readonly [rowsByIndex]: RowsByIndex;

  constructor(backend: Backend) {
    this.#backend = backend;
    this[rowsByIndex] = new KeptRows(this, backend);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#backend, link);
  }

  async write(batch: Batch): Promise<void> {
    await (await this.stage(batch)).commit();
  }

  async stage({ records = [], roots = [], blobs = [] }: Batch): Promise<StagedStore> {
    const batch = copiedBatch(records, blobs, "recorded");
    const recordLinks: Link<RecordObject>[] = [];
    for (const link of batch.objects) {
      const record = encodeObject(recordSchema, { object: new LinkValue(link) });
      batch.blobs.set(record.link, record.bytes);
      recordLinks.push(record.link);
    }
    for (const blob of recordSchema.blobs) batch.blobs.set(linkOf(blob), blob);
    const keptBlobs = await leavesFirst([...recordLinks, ...roots], batch.blobs, this.#backend);
    return new StagedStoreOf(this, this.#backend, keptBlobs, recordLinks, batch.objects);
  }

  records(): AsyncIterable<Link<RecordObject>> {
    // A store lists only the records it writes.
    return this.#backend.records() as AsyncIterable<Link<RecordObject>>;
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#backend.positionOf(link);
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
      put: async (blobs, records) => {
        const ownBlobs = new Map<Link<unknown>, Uint8Array>();
        for (const [link, bytes] of blobs) if (!(await sharedBackend.has(link))) ownBlobs.set(link, bytes);
        await backend.put(ownBlobs, records);
      },
      records: (start) => backend.records(start),
      blobs: (start) => backend.blobs(start),
      positionOf: (link) => backend.positionOf(link),
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

  async closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    const closureBlobs = new Map<Link<unknown>, Uint8Array>();
    const seenLinks = new Set([link]);
    const pendingLinks = [link];
    for (let next = pendingLinks.pop(); next !== undefined; next = pendingLinks.pop()) {
      const bytes = await this.get(next);
      if (bytes === undefined) throw new Error(`the store does not hold ${next}`);
      closureBlobs.set(next, bytes);
      for (const targetLink of linksIn(bytes)) {
        if (seenLinks.has(targetLink)) continue;
        seenLinks.add(targetLink);
        pendingLinks.push(targetLink);
      }
    }
    return closureBlobs;
  }
}

class StagedStoreOf implements StagedStore, RowKeeper {
  readonly #store: Pick<Store, "get" | "positionOf"> & RowKeeper;
  readonly #backend: Backend;
  readonly #blobs: ReadonlyMap<Link<unknown>, Uint8Array>;
  readonly #records: readonly Link<RecordObject>[];
  readonly #recordedObjects: readonly Link<EncodedObject>[];

  constructor(
    store: Pick<Store, "get" | "positionOf"> & RowKeeper,
    backend: Backend,
    blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
    records: readonly Link<RecordObject>[],
    recordedObjects: readonly Link<EncodedObject>[],
  ) {
    this.#store = store;
    this.#backend = backend;
    this.#blobs = blobs;
    this.#records = records;
    this.#recordedObjects = recordedObjects;
  }

  get [rowsByIndex](): RowsByIndex {
    const added = { recordedObjects: this.#recordedObjects, blobs: [...this.#blobs.keys()] };
    return new AddedRows(this.#store[rowsByIndex], added, this);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes === undefined ? this.#store.get(link) : new Uint8Array(bytes);
  }

  async *records(): AsyncIterable<Link<RecordObject>> {
    const unlistedLinks = new Set(this.#records);
    for await (const link of this.#backend.records() as AsyncIterable<Link<RecordObject>>) {
      unlistedLinks.delete(link);
      yield link;
    }
    yield* unlistedLinks;
  }

  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#store.positionOf(link);
  }

  commit(): Promise<void> {
    return this.#backend.put(this.#blobs, this.#records);
  }
}

/** Makes a store that keeps its blobs and its records in `backend`. */
export const Store: new (backend: Backend) => Store = StoreOf;
