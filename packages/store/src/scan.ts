import type { Link, Reader, Selection } from "@estoc/object";
import type { Store } from "./store.ts";

/**
 * The key of a row: strings and numbers.
 *
 * - Keys are compared one part at a time, a number before a string, and a key before every longer
 *   key that starts with it, so the keys that start with a prefix come together.
 * - Numbers are finite, as in JSON.
 */
export type Key = readonly (string | number)[];

/**
 * The keys that start a key of `K`, from none of it to all of it. The empty
 * prefix stands outside the condition, so that it fits even a `K` that is
 * still a type parameter.
 */
export type Prefix<K extends Key> =
  | readonly []
  | (K extends readonly [infer First extends Key[number], ...infer Rest extends Key]
      ? readonly [First, ...Prefix<Rest>]
      : K);

/** The rows of the record that a link names, read from a reader. */
type Part<K extends Key> = (record: Link<unknown>, reader: Reader) => AsyncIterable<K>;

// `scan` reads the parts of an index, which nothing outside this module can.
let partsOf: <K extends Key>(index: Index<K>) => readonly Part<K>[];

/**
 * What an application keeps of the records that some selections take among
 * those its user writes, as rows. An index is the set of rows that those
 * records give, so going through all of them and adding each as it is
 * written come to the same rows, whatever the order and however often a
 * record is added.
 *
 * An index comes only from `indexOver` and `union`, so which records it
 * reads is said by its selections and not by its rows.
 */
export class Index<K extends Key> {
  readonly #parts: readonly Part<K>[];

  static {
    partsOf = (index) => index.#parts;
  }

  constructor(parts: readonly Part<K>[]) {
    this.#parts = parts;
  }

  /**
   * The index of the records that this index and `others` read, with the
   * rows that each of them gives. Each selection reads its own records and
   * hands what it reads them as to its own rows, so two selections that take
   * one record each give the rows of what they read.
   */
  union(...others: readonly Index<K>[]): Index<K> {
    return new Index([...this.#parts, ...others.flatMap((other) => other.#parts)]);
  }
}

/**
 * The index of the records that `selection` takes, with the rows that `rows` gives of what it
 * reads each one as. The rows depend on the record and its closure, which `reader` gives by link,
 * and on nothing else; what depends on what else is written, such as whether something replaced
 * the record, is worked out from the rows when they are read.
 */
export function indexOver<K extends Key, T>(
  selection: Selection<T>,
  rows: (item: T, reader: Reader) => Iterable<K> | AsyncIterable<K>,
): Index<K> {
  return new Index([
    async function* (record, reader) {
      const item = await selection.read(record, reader);
      if (item !== undefined) yield* rows(item, reader);
    },
  ]);
}

/** The rows of an index, each once however many records give it. */
export interface Rows<K extends Key> {
  /** The rows whose keys start with `prefix`, in the order of their keys. */
  range(prefix: Prefix<K>): AsyncIterable<K>;
}

/**
 * Fills `index` from all the records of `store`, which may also be a `PrivateStore` or a
 * `StagedStore`.
 *
 * - Only records reach an index, and on a staged batch the batch's records as well: what came
 *   from elsewhere is reached by following links from them.
 * - Each selection of the index is given each record, and reads it from the store.
 * - Within one record, a blob, the record among them, is read from the store once, however many
 *   selections and rows read it.
 *
 * @throws where a selection or its rows throw, as `objectsOf` does for an object that does not
 * fit its schema.
 * @throws when a row holds a number that is not finite.
 */
export async function scan<K extends Key>(store: Pick<Store, "get" | "records">, index: Index<K>): Promise<Rows<K>> {
  const rows = new Map<string, K>();
  for await (const link of store.records()) {
    const reader = readerOnce(store);
    for (const part of partsOf(index)) {
      for await (const key of part(link, reader)) {
        if (!key.every((part) => typeof part === "string" || Number.isFinite(part)))
          throw new Error(`a row of ${link} holds a number that is not finite`);
        rows.set(JSON.stringify(key), Object.freeze([...key]) as K);
      }
    }
  }
  return new SortedRows([...rows.values()].sort(compare));
}

/** A reader that gets each blob from `reader` once and keeps it: a link names one blob. */
function readerOnce(reader: Reader): Reader {
  const blobs = new Map<Link<unknown>, Promise<Uint8Array | undefined>>();
  return {
    get(link) {
      const bytes = blobs.get(link) ?? Promise.resolve(reader.get(link));
      blobs.set(link, bytes);
      return bytes;
    },
  };
}

class SortedRows<K extends Key> implements Rows<K> {
  readonly #rows: readonly K[];

  constructor(rows: readonly K[]) {
    this.#rows = rows;
  }

  // biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
  async *range(prefix: Prefix<K>): AsyncIterable<K> {
    const start: Key = [...prefix];
    const rows = this.#rows;
    let low = 0;
    for (let high = rows.length; low < high; ) {
      const middle = (low + high) >>> 1;
      if (compare(rows[middle]!, start) < 0) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < rows.length && start.every((part, i) => rows[at]![i] === part); at++) yield rows[at]!;
  }
}

function compare(a: Key, b: Key): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const [x, y] = [a[i]!, b[i]!];
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
// biome-ignore-end lint/style/noNonNullAssertion: each index is below the length it is checked against
