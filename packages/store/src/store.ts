import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  type ObjectValue,
  objectFormat,
  schemaOf,
} from "@estoc/object";
import { type RecordObject, recordSchema } from "./record.ts";
import { AddedRows, KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";

/**
 * Where a store keeps its blobs and the list of its records: memory, a file, or storage in a
 * browser. It keeps bytes and links as it is given them; the store hashes and decodes, and hashes again what it
 * gets back, so a backend that was damaged makes reading fail.
 */
export interface Backend {
  /**
   * The bytes put under `link`, in an array the caller may change without
   * changing what is kept, or `undefined` when none were.
   */
  get(link: Link<unknown>): Promise<Uint8Array | undefined>;
  /** Whether bytes were put under `link`. */
  has(link: Link<unknown>): Promise<boolean>;
  /**
   * Puts each blob under its link, one after another in the order given, and then lists `records`.
   *
   * - The store gives each blob after the blobs it links to, and a link is listed only once its
   *   blob is in, so a write cut short leaves no blob without its closure and no listed link
   *   without its blob.
   * - The backend of a `PrivateStore` is not given what the store beside it holds, so there these
   *   hold of the two together: part of a blob's closure, or the blob of a listed link, may be in
   *   the store beside instead.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, records: Iterable<Link<RecordObject>>): Promise<void>;
  /**
   * The links listed by `put`, each once and in the order they were first listed, leaving out the
   * first `start`.
   */
  records(start?: number): AsyncIterable<Link<RecordObject>>;
  /**
   * The links of the blobs put, each once and in the order they were first put, leaving out the
   * first `start`. A write cut short can leave blobs here that no listed link reaches.
   */
  blobs(start?: number): AsyncIterable<Link<unknown>>;
  /** Where the blob under `link` is in `blobs`, counting from 0, or `undefined` when none was put under it. */
  positionOf(link: Link<unknown>): Promise<number | undefined>;
}

/** What one write puts in a store. */
export interface Batch {
  /**
   * Objects that the user of the store writes, of whatever type the caller holds them as: only
   * their bytes are written. The store records each: it writes a record, an object of
   * `recordSchema` that links to the object, and lists the record.
   */
  readonly records?: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Blobs that come with them and are not recorded: what the objects link to, or the blobs of a
   * bundle received along with an object that notes its arrival. Only those in the closure of a
   * recorded object are kept.
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
 * - A write adds only the blobs in the closures of its records.
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
   * Records each of the batch's `records`: puts in a record of it and the blobs in the record's
   * closure, the object among them, and lists the record. The other blobs are dropped. A refused
   * batch writes nothing.
   *
   * @throws {RefusedBatch} when one of `records` is not an object.
   * @throws {RefusedBatch} when a blob in the closure of one of `records` is neither in the batch
   *   nor held by the store, such as the schema of an object or a blob its data links to.
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

/**
 * A batch that a store refuses for what it is: one of its `records` that is not an object, or a
 * blob in the closure of one that neither the batch nor the store holds. The same batch is refused again
 * until the store holds what was missing, while a backend that fails, which rejects with an error
 * of its own, may write it the next time.
 */
export class RefusedBatch extends Error {
  override readonly name = "RefusedBatch";
}

class StoreOf implements Store, RowKeeper {
  readonly #backend: Backend;
  readonly [rowsByIndex]: RowsByIndex;

  constructor(backend: Backend) {
    this.#backend = backend;
    this[rowsByIndex] = new KeptRows(this, backend);
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = await this.#backend.get(link);
    if (bytes !== undefined && linkOf(bytes) !== link) throw new Error(`the backend holds another blob under ${link}`);
    return bytes;
  }

  async write(batch: Batch): Promise<void> {
    await (await this.stage(batch)).commit();
  }

  async stage({ records = [], blobs = [] }: Batch): Promise<StagedStore> {
    // Each blob is copied before it is hashed, so that what is kept is what
    // was hashed, whatever happens to the given arrays afterwards.
    const batchBlobs = new Map<Link<unknown>, Uint8Array>();
    for (const blob of blobs) {
      const ownedBytes = new Uint8Array(blob);
      batchBlobs.set(linkOf(ownedBytes), ownedBytes);
    }
    const recordLinks: Link<RecordObject>[] = [];
    const objectLinks: Link<EncodedObject>[] = [];
    for (const { bytes } of records) {
      const ownedBytes: Bytes<EncodedObject> = new Uint8Array(bytes);
      const link = linkOf(ownedBytes);
      try {
        schemaOf(ownedBytes);
      } catch (cause) {
        throw new RefusedBatch(`${link} is recorded but is not an object`, { cause });
      }
      const record = encodeObject(recordSchema, { object: new LinkValue(link) });
      batchBlobs.set(link, ownedBytes);
      batchBlobs.set(record.link, record.bytes);
      recordLinks.push(record.link);
      objectLinks.push(link);
    }
    for (const blob of recordSchema.blobs) batchBlobs.set(linkOf(blob), blob);
    const keptBlobs = await this.#leavesFirst(recordLinks, batchBlobs);
    return new StagedStoreOf(this, this.#backend, keptBlobs, recordLinks, objectLinks);
  }

  records(): AsyncIterable<Link<RecordObject>> {
    return this.#backend.records();
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }

  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#backend.positionOf(link);
  }

  /**
   * A store that writes to `backend` and holds besides all that `store`
   * holds. What `store` holds already is not put in `backend` again.
   */
  static beside(store: Store, backend: Backend): Store & RowKeeper {
    if (!(#backend in store)) throw new TypeError("a private store is kept beside a store made by `new Store`");
    const sharedBackend = store.#backend;
    return new StoreOf({
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
    });
  }

  async closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    const closureBlobs = new Map<Link<unknown>, Uint8Array>();
    const seenLinks = new Set([link]);
    const pendingLinks = [link];
    for (let next = pendingLinks.pop(); next !== undefined; next = pendingLinks.pop()) {
      const bytes = await this.get(next);
      if (bytes === undefined) throw new Error(`the store does not hold ${next}`);
      closureBlobs.set(next, bytes);
      for (const targetLink of this.#linksIn(bytes)) {
        if (seenLinks.has(targetLink)) continue;
        seenLinks.add(targetLink);
        pendingLinks.push(targetLink);
      }
    }
    return closureBlobs;
  }

  /**
   * `records` and the blobs of `blobs` in their closures, each after the blobs it links to. A held
   * blob comes with its closure, so its links are not followed.
   *
   * @throws {RefusedBatch} when a blob in the closure of one of `records` is neither in `blobs` nor
   *   held.
   */
  async #leavesFirst(
    records: readonly Link<unknown>[],
    blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
  ): Promise<Map<Link<unknown>, Uint8Array>> {
    const orderedBlobs = new Map<Link<unknown>, Uint8Array>();
    const heldLinks = new Set<Link<unknown>>();
    const frame = (link: Link<unknown>, bytes: Uint8Array) => ({
      link,
      bytes,
      links: this.#linksIn(bytes)[Symbol.iterator](),
    });
    for (const start of records) {
      if (orderedBlobs.has(start)) continue;
      // A link is a hash of its blob, so no blob on the path is in the closure of one after it.
      // biome-ignore lint/style/noNonNullAssertion: each record is among the blobs
      const path = [frame(start, blobs.get(start)!)];
      for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
        const next = top.links.next();
        if (next.done) {
          orderedBlobs.set(top.link, top.bytes);
          path.pop();
          continue;
        }
        const targetLink = next.value;
        if (orderedBlobs.has(targetLink) || heldLinks.has(targetLink)) continue;
        const targetBytes = blobs.get(targetLink);
        if (targetBytes !== undefined) {
          path.push(frame(targetLink, targetBytes));
        } else if (await this.#backend.has(targetLink)) {
          heldLinks.add(targetLink);
        } else {
          throw new RefusedBatch(`${top.link} links to ${targetLink}, which neither the batch nor the store holds`);
        }
      }
    }
    return orderedBlobs;
  }

  #linksIn(bytes: Uint8Array): Iterable<Link<unknown>> {
    let object: ObjectValue;
    try {
      object = objectFormat.decode(bytes);
    } catch {
      return [];
    }
    return objectFormat.links(object);
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
    for await (const link of this.#backend.records()) {
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

/**
 * What the user keeps to themselves: objects they write and the blobs in their closures, kept
 * apart from the store that bundles are gathered from.
 *
 * - It is kept beside a store, in a backend of its own, and reads that store too, so what is kept
 *   here can link to what the store holds.
 * - The store does not read it: a blob that only this keeps is not held by the store, so the store
 *   refuses to write anything with one in its closure, and neither its `get` nor its `closure`
 *   gives one.
 * - There is no `closure` here, and this is not a `Store`, so it cannot be given to what gathers
 *   bundles from a store.
 * - Bytes that are also written to the store are the store's as well.
 * - Whether what is kept here is encrypted is up to the backend.
 */
export class PrivateStore {
  // A private field makes the type nominal, unlike the interface `Store`, so a
  // store, which has every method of this one, cannot be given in its place.
  readonly #store: Store & RowKeeper;

  /**
   * Keeps what is written to it in `backend`, beside `store`.
   *
   * @throws {TypeError} for a store not made by `new Store`.
   */
  constructor(store: Store, backend: Backend) {
    this.#store = StoreOf.beside(store, backend);
  }

  /**
   * A blob by its link, kept here or held by the store beside.
   *
   * @throws when a backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#store.get(link);
  }

  /**
   * Records each of the batch's `records` here, as a store writes them. A blob of a closure that
   * the store beside holds counts as held and is not kept here again, a record among them.
   */
  write(batch: Batch): Promise<void> {
    return this.#store.write(batch);
  }

  /** The links of the records listed here, each once, in no particular order, as a store's `records` gives them. */
  records(): AsyncIterable<Link<RecordObject>> {
    return this.#store.records();
  }

  /**
   * The links of the blobs kept here, each once and in the order they were kept, as a store's
   * `blobs` gives them. A blob that only the store beside holds was not kept here, and is not
   * among them.
   */
  blobs(): AsyncIterable<Link<unknown>> {
    return this.#store.blobs();
  }

  /**
   * How many blobs were kept here before the one of `link`, as a store's `positionOf` gives it. A
   * blob that only the store beside holds was not kept here, and has none.
   */
  positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#store.positionOf(link);
  }

  get [rowsByIndex](): RowsByIndex {
    return this.#store[rowsByIndex];
  }
}
