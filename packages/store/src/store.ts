import { linkOf, schemaOf, type Bytes, type Encoding, type Link, type Semantics } from "@estoc/object";

/**
 * Where a store keeps its blobs and the list of what was written to it:
 * memory, a folder, or storage in a browser. It keeps bytes and links as it
 * is given them; the store hashes and decodes.
 */
export interface Backend {
  /** The bytes put under `link`, or `undefined` when none were. */
  get(link: Link<unknown>): Promise<Uint8Array | undefined>;
  /**
   * Puts each blob under its link, and then adds `mine` to the list of what
   * was written. A link is listed only once its blob is in, so a write cut
   * short leaves blobs that nothing lists rather than a listed link with no
   * blob.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, mine: Iterable<Link<never>>): Promise<void>;
  /** The links listed by `put`, each once. */
  mine(): AsyncIterable<Link<never>>;
}

/** What one write puts in a store. */
export interface Batch {
  /**
   * Objects that the user of the store writes, in whatever type a semantics
   * wrote them as. `mine` lists them.
   */
  readonly mine?: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Blobs that come with them and are not listed: what the objects link to,
   * or the blobs of a bundle received along with an object that records
   * receiving it.
   */
  readonly blobs?: Iterable<Bytes<unknown>>;
}

/**
 * The objects a user writes and the blobs that come with them. Blobs are
 * kept by link, whoever wrote them, and got by link; they are not listed.
 * What is listed is what the user wrote, and anything else is reached by
 * following links from it, so an object that someone else slipped into a
 * bundle is read only as part of what it came with.
 */
export interface Store {
  /** A blob by its link, written to the store as mine or not. */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * Puts a batch in. Refuses the whole batch when something written as mine
   * is not an object of the store's encoding.
   */
  write(batch: Batch): Promise<void>;
  /** The links of the objects written as mine, each once, in no particular order. */
  mine(): AsyncIterable<Link<never>>;
  /**
   * The blob that `link` names and the blobs it leads to, as far as the store
   * holds them: a blob of the store's encoding leads to the links that the
   * encoding finds in it, the schema of an object included, and any other
   * blob, such as an image, leads nowhere. A blob the store does not hold is
   * left out, and so is what it would lead to.
   */
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
  /** Reads the object that `link` names through `semantics`, with its closure as the blobs. */
  read<T>(semantics: Semantics<T>, link: Link<T>): Promise<T>;
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
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return this.#backend.get(link);
  }

  async write({ mine = [], blobs = [] }: Batch): Promise<void> {
    // Each blob is copied before it is hashed, so that what is kept is what
    // was hashed, whatever happens to the given arrays afterwards.
    const put = new Map<Link<unknown>, Uint8Array>();
    for (const blob of blobs) {
      const owned = new Uint8Array(blob);
      put.set(linkOf(owned), owned);
    }
    const written: Link<never>[] = [];
    for (const { bytes } of mine) {
      const owned = new Uint8Array(bytes);
      const link = linkOf(owned);
      try {
        schemaOf(owned, this.#encoding);
      } catch (cause) {
        throw new Error(`${link} is written as mine but is not an object`, { cause });
      }
      put.set(link, owned);
      written.push(link);
    }
    await this.#backend.put(put, written);
  }

  mine(): AsyncIterable<Link<never>> {
    return this.#backend.mine();
  }

  async closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>> {
    const gathered = new Map<Link<unknown>, Uint8Array>();
    const seen = new Set([link]);
    const pending = [link];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const bytes = await this.#backend.get(next);
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

  async read<T>(semantics: Semantics<T>, link: Link<T>): Promise<T> {
    return semantics.follow(link, await this.closure(link));
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

/**
 * Makes a store that keeps its blobs and its list in `backend`, and finds
 * the links in a blob by `encoding`. The encoding is the one of the objects
 * written as mine; blobs of any other encoding are kept, and lead nowhere.
 */
export const Store: new <D>(encoding: Encoding<D>, backend: Backend) => Store = StoreOf;
