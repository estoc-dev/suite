import { type Bytes, type Encoding, type Link, linkOf, schemaOf } from "@estoc/object";

/**
 * Where a store keeps its blobs and the list of what was written to it:
 * memory, a folder, or storage in a browser. It keeps bytes and links as it
 * is given them; the store hashes and decodes, and hashes again what it gets
 * back, so a backend that was damaged makes reading fail.
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
   * Puts each blob under its link, one after another in the order given,
   * and then adds `records` to the list of what was written. The store gives
   * each blob after the blobs it leads to, and a link is listed only once
   * its blob is in, so a write cut short leaves no blob without what it
   * leads to and no listed link without its blob. The backend of a
   * `PrivateStore` is not given what the store beside it holds, so there
   * these hold of the two together: what a blob leads to, or the blob of a
   * listed link, may be in the store beside instead.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, records: Iterable<Link<never>>): Promise<void>;
  /** The links listed by `put`, each once. */
  records(): AsyncIterable<Link<never>>;
}

/** What one write puts in a store. */
export interface Batch {
  /**
   * Objects that the user of the store writes, of whatever type the caller
   * holds them as: only their bytes are written. The store lists them.
   */
  readonly records?: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Blobs that come with them and are not listed: what the objects link to,
   * or the blobs of a bundle received along with an object that notes its
   * arrival. Only those that a record leads to are kept.
   */
  readonly blobs?: Iterable<Bytes<unknown>>;
}

/**
 * The objects a user writes and the blobs that come with them. Blobs are
 * kept by link, whoever wrote them, and got by link; they are not listed.
 * What is listed is what the user wrote, and anything else is reached by
 * following links from it, so an object that someone else slipped into a
 * bundle is read only as part of what it came with. Every blob a store holds
 * comes with all that it leads to, and a write adds only the blobs that its
 * records lead to.
 */
export interface Store {
  /**
   * A blob by its link, a record or not. Throws when the
   * backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * Puts in the batch's records and the blobs they lead to, and drops the
   * other blobs. Refuses the whole batch with a `RefusedBatch` when a record
   * is not an object of the store's encoding, or
   * when it leads to a blob that neither the batch nor the store holds: the
   * schema of an object, or any other link in it. A backend that fails
   * rejects with an error of its own.
   */
  write(batch: Batch): Promise<void>;
  /**
   * The store as it will be once `batch` is written, to read before writing
   * it. Refuses the batch as `write` does, before anything reads it, and
   * keeps of its blobs those that `write` would. `write(batch)` writes as
   * `(await store.stage(batch)).commit()` does.
   */
  stage(batch: Batch): Promise<StagedStore>;
  /** The links of the records, each once, in no particular order. */
  records(): AsyncIterable<Link<never>>;
  /**
   * The blob that `link` names and every blob it leads to, or nothing when
   * the store does not hold it. A blob of the store's encoding leads to the
   * links that the encoding finds in it, the schema of an object included,
   * and any other blob, such as an image, leads nowhere. Throws as `get`
   * does.
   */
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
}

/**
 * A store as it will be once a batch is written, read before the batch is
 * written: the blobs the store holds and those of the batch that `write`
 * keeps, and the links of the store's records with those of the batch.
 * The batch is fixed when it is staged, and the store is read as it is at
 * each read, so what is written to the store afterwards shows here too.
 * What is judged on it reads the same from the store once it is committed
 * when nothing else is written in between. A write in between, such as of a
 * version that takes an agent out, can change what a view comes to when it
 * is viewed again, here as on the store, and `commit` does not judge the
 * batch again. A store only grows, so the batch can still be committed
 * after other writes, and what it leads to is still held.
 */
export interface StagedStore {
  /**
   * A blob by its link, of the batch or held by the store, in an array the
   * caller may change without changing what `commit` writes. Throws as the
   * store's `get` does.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * The links of the store's records and of the batch's, each once, in no
   * particular order. Those of the batch are listed here before
   * anything has judged them.
   */
  records(): AsyncIterable<Link<never>>;
  /** Writes the batch as `write` writes it. Committing again writes nothing more. */
  commit(): Promise<void>;
}

/**
 * A batch that a store refuses for what it is: a record that is not an
 * object, or a link to a blob that neither the batch nor the
 * store holds. The same batch is refused again until the store holds what it
 * leads to, while a backend that fails, which rejects with an error of its
 * own, may write it the next time.
 */
export class RefusedBatch extends Error {
  override readonly name = "RefusedBatch";
}

class StoreOf<D> implements Store {
  readonly #encoding: Encoding<D>;
  readonly #backend: Backend;

  constructor(encoding: Encoding<D>, backend: Backend) {
    this.#encoding = encoding;
    this.#backend = backend;
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
    const given = new Map<Link<unknown>, Uint8Array>();
    for (const blob of blobs) {
      const owned = new Uint8Array(blob);
      given.set(linkOf(owned), owned);
    }
    const written: Link<never>[] = [];
    for (const { bytes } of records) {
      const owned = new Uint8Array(bytes);
      const link = linkOf(owned);
      try {
        schemaOf(owned, this.#encoding);
      } catch (cause) {
        throw new RefusedBatch(`${link} is written as a record but is not an object`, { cause });
      }
      given.set(link, owned);
      written.push(link);
    }
    return new StagedStoreOf(this, this.#backend, await this.#leavesFirst(written, given), written);
  }

  records(): AsyncIterable<Link<never>> {
    return this.#backend.records();
  }

  /**
   * A store that writes to `backend` and holds besides all that `store`
   * holds, of the same encoding. What `store` holds already is not put in
   * `backend` again.
   */
  static beside(store: Store, backend: Backend): Store {
    if (!(#backend in store)) throw new TypeError("a private store is kept beside a store made by `new Store`");
    const shared = store.#backend;
    return new StoreOf(store.#encoding, {
      get: async (link) => (await backend.get(link)) ?? shared.get(link),
      has: async (link) => (await backend.has(link)) || shared.has(link),
      put: async (blobs, records) => {
        const own = new Map<Link<unknown>, Uint8Array>();
        for (const [link, bytes] of blobs) if (!(await shared.has(link))) own.set(link, bytes);
        await backend.put(own, records);
      },
      records: () => backend.records(),
    });
  }

  async closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    const gathered = new Map<Link<unknown>, Uint8Array>();
    const seen = new Set([link]);
    const pending = [link];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const bytes = await this.get(next);
      if (bytes === undefined) continue;
      gathered.set(next, bytes);
      for (const linked of this.#linksIn(bytes)) {
        if (seen.has(linked)) continue;
        seen.add(linked);
        pending.push(linked);
      }
    }
    return gathered;
  }

  /**
   * `records` and the blobs of `blobs` they lead to, each after those it
   * leads to. Throws when one leads to a blob that is neither in `blobs` nor
   * held.
   * A held blob comes with all it leads to, so what it leads to is not looked
   * at again.
   */
  async #leavesFirst(
    records: readonly Link<unknown>[],
    blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
  ): Promise<Map<Link<unknown>, Uint8Array>> {
    const ordered = new Map<Link<unknown>, Uint8Array>();
    const held = new Set<Link<unknown>>();
    const frame = (link: Link<unknown>, bytes: Uint8Array) => ({
      link,
      bytes,
      links: this.#linksIn(bytes)[Symbol.iterator](),
    });
    for (const start of records) {
      if (ordered.has(start)) continue;
      // A link is a hash of its blob, so no blob leads back to one on the path.
      // biome-ignore lint/style/noNonNullAssertion: each record is among the blobs
      const path = [frame(start, blobs.get(start)!)];
      for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
        const next = top.links.next();
        if (next.done) {
          ordered.set(top.link, top.bytes);
          path.pop();
          continue;
        }
        const linked = next.value;
        if (ordered.has(linked) || held.has(linked)) continue;
        const linkedBytes = blobs.get(linked);
        if (linkedBytes !== undefined) {
          path.push(frame(linked, linkedBytes));
        } else if (await this.#backend.has(linked)) {
          held.add(linked);
        } else {
          throw new RefusedBatch(`${top.link} leads to ${linked}, which neither the batch nor the store holds`);
        }
      }
    }
    return ordered;
  }

  #linksIn(bytes: Uint8Array): Iterable<Link<unknown>> {
    let value: D;
    try {
      value = this.#encoding.decode(bytes);
    } catch {
      return [];
    }
    return this.#encoding.links(value);
  }
}

class StagedStoreOf implements StagedStore {
  readonly #store: Pick<Store, "get">;
  readonly #backend: Backend;
  readonly #blobs: ReadonlyMap<Link<unknown>, Uint8Array>;
  readonly #records: readonly Link<never>[];

  constructor(
    store: Pick<Store, "get">,
    backend: Backend,
    blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
    records: readonly Link<never>[],
  ) {
    this.#store = store;
    this.#backend = backend;
    this.#blobs = blobs;
    this.#records = records;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  async get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes === undefined ? this.#store.get(link) : new Uint8Array(bytes);
  }

  async *records(): AsyncIterable<Link<never>> {
    const unlisted = new Set(this.#records);
    for await (const link of this.#backend.records()) {
      unlisted.delete(link);
      yield link;
    }
    yield* unlisted;
  }

  commit(): Promise<void> {
    return this.#backend.put(this.#blobs, this.#records);
  }
}

/**
 * Makes a store that keeps its blobs and its list in `backend`, and finds
 * the links in a blob by `encoding`. The encoding is the one of the records,
 * and a blob of any other encoding leads nowhere. A
 * backend is to be used with one encoding throughout, since the store takes
 * a blob it holds to come with all that the encoding finds it leads to.
 */
export const Store: new <D>(encoding: Encoding<D>, backend: Backend) => Store = StoreOf;

/**
 * What the user keeps to themselves: objects they write, and the blobs those
 * lead to, kept apart from the store that bundles are gathered from. It is
 * kept beside a store, in a backend of its own, and reads that store too, so
 * what is kept here can link to what the store holds. The store does not
 * read it: a blob that only this keeps is not held by the store, so the store
 * refuses to write anything that leads to one, and neither its `get` nor its
 * `closure` gives one. There is no `closure` here, and this is not a `Store`,
 * so it cannot be given to what gathers bundles from a store. Bytes that are
 * also written to the store are the store's as well.
 *
 * Whether what is kept here is encrypted is up to the backend.
 */
export class PrivateStore {
  // A private field makes the type nominal, unlike the interface `Store`, so a
  // store, which has every method of this one, cannot be given in its place.
  readonly #store: Store;

  /**
   * Keeps what is written to it in `backend`, beside `store`, whose encoding
   * it finds links by. Throws for a store not made by `new Store`.
   */
  constructor(store: Store, backend: Backend) {
    this.#store = StoreOf.beside(store, backend);
  }

  /**
   * A blob by its link, kept here or held by the store beside. Throws when a
   * backend gives other bytes under the link.
   */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#store.get(link);
  }

  /**
   * Keeps the batch's records and the blobs they lead to, as a store writes
   * them. A blob led to may be held by the store beside, and
   * then is not kept here again.
   */
  write(batch: Batch): Promise<void> {
    return this.#store.write(batch);
  }

  /** The links of the records written here, each once, in no particular order. */
  records(): AsyncIterable<Link<never>> {
    return this.#store.records();
  }
}
