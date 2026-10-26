import { type Bytes, type Encoding, type Link, linkOf, schemaOf } from "@estoc/object";

/**
 * Where a store keeps its blobs and the list of what was written to it:
 * memory, a folder, or storage in a browser. It keeps bytes and links as it
 * is given them; the store hashes and decodes.
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
   * and then adds `mine` to the list of what was written. The store gives
   * each blob after the blobs it leads to, and a link is listed only once
   * its blob is in, so a write cut short leaves no blob without what it
   * leads to and no listed link without its blob.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, mine: Iterable<Link<never>>): Promise<void>;
  /** The links listed by `put`, each once. */
  mine(): AsyncIterable<Link<never>>;
}

/** What one write puts in a store. */
export interface Batch {
  /**
   * Objects that the user of the store writes, of whatever type the caller
   * holds them as: only their bytes are written. `mine` lists them.
   */
  readonly mine?: Iterable<{ readonly bytes: Bytes<unknown> }>;
  /**
   * Blobs that come with them and are not listed: what the objects link to,
   * or the blobs of a bundle received along with an object that records
   * receiving it. Only those that something written as mine leads to are
   * kept.
   */
  readonly blobs?: Iterable<Bytes<unknown>>;
}

/**
 * The objects a user writes and the blobs that come with them. Blobs are
 * kept by link, whoever wrote them, and got by link; they are not listed.
 * What is listed is what the user wrote, and anything else is reached by
 * following links from it, so an object that someone else slipped into a
 * bundle is read only as part of what it came with. Every blob a store holds
 * comes with all that it leads to, and a write adds only the blobs that what
 * it writes as mine leads to.
 */
export interface Store {
  /** A blob by its link, written to the store as mine or not. */
  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  /**
   * Puts in what the batch writes as mine and the blobs it leads to, and
   * drops the other blobs. Refuses the whole batch when something written as
   * mine is not an object of the store's encoding, or when it leads to a blob
   * that neither the batch nor the store holds: the schema of an object, or
   * any other link in it.
   */
  write(batch: Batch): Promise<void>;
  /** The links of the objects written as mine, each once, in no particular order. */
  mine(): AsyncIterable<Link<never>>;
  /**
   * The blob that `link` names and every blob it leads to, or nothing when
   * the store does not hold it. A blob of the store's encoding leads to the
   * links that the encoding finds in it, the schema of an object included,
   * and any other blob, such as an image, leads nowhere.
   */
  closure(link: Link<unknown>): Promise<ReadonlyMap<Link<unknown>, Uint8Array>>;
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
    const given = new Map<Link<unknown>, Uint8Array>();
    for (const blob of blobs) {
      const owned = new Uint8Array(blob);
      given.set(linkOf(owned), owned);
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
      given.set(link, owned);
      written.push(link);
    }
    await this.#backend.put(await this.#leavesFirst(written, given), written);
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

  /**
   * `mine` and the given blobs it leads to, each after the given blobs it
   * leads to. Throws when one leads to a blob that is neither given nor held.
   * A held blob comes with all it leads to, so what it leads to is not looked
   * at again.
   */
  async #leavesFirst(
    mine: readonly Link<unknown>[],
    given: ReadonlyMap<Link<unknown>, Uint8Array>,
  ): Promise<Map<Link<unknown>, Uint8Array>> {
    const ordered = new Map<Link<unknown>, Uint8Array>();
    const held = new Set<Link<unknown>>();
    const frame = (link: Link<unknown>, bytes: Uint8Array) => ({
      link,
      bytes,
      links: this.#linksIn(bytes)[Symbol.iterator](),
    });
    for (const start of mine) {
      if (ordered.has(start)) continue;
      // A link is a hash of its blob, so no blob leads back to one on the path.
      const path = [frame(start, given.get(start)!)];
      while (path.length > 0) {
        const top = path.at(-1)!;
        const next = top.links.next();
        if (next.done) {
          ordered.set(top.link, top.bytes);
          path.pop();
          continue;
        }
        const linked = next.value;
        if (ordered.has(linked) || held.has(linked)) continue;
        const linkedBytes = given.get(linked);
        if (linkedBytes !== undefined) {
          path.push(frame(linked, linkedBytes));
        } else if (await this.#backend.has(linked)) {
          held.add(linked);
        } else {
          throw new Error(
            `${top.link} leads to ${linked}, which neither the batch nor the store holds`,
          );
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

/**
 * Makes a store that keeps its blobs and its list in `backend`, and finds
 * the links in a blob by `encoding`. The encoding is the one of the objects
 * written as mine, and a blob of any other encoding leads nowhere. A
 * backend is to be used with one encoding throughout, since the store takes
 * a blob it holds to come with all that the encoding finds it leads to.
 */
export const Store: new <D>(encoding: Encoding<D>, backend: Backend) => Store = StoreOf;
