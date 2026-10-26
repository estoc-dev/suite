import {
  decodeObject,
  type EncodedObject,
  type Fields,
  type Reader,
  type Schema,
  schemaOf,
} from "@estoc/object";
import type { Store } from "./store.ts";

/**
 * The key of a row: strings and numbers, compared one by one, a number
 * before a string, and a key before every longer key that starts with it.
 * The keys that start with a prefix therefore come together. Numbers are
 * finite, as in JSON, and a scan fails on a row that holds any other.
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

/**
 * What an application keeps of the objects of some schemas that its user
 * writes, as rows. An index is the set of rows that those objects give, so
 * going through all of them and adding each as it is written come to the
 * same rows, whatever the order and however often an object is added.
 */
export interface Index<D, K extends Key, F extends Fields<D> = Fields<D>> {
  /** The schemas of the objects the index reads. It passes over objects of any other. */
  readonly reads: readonly Schema<D, F>[];
  /**
   * The rows of an object of one of those schemas, whose data fits it. They
   * depend on the object and what it leads to, which `reader` gives by link,
   * and on nothing else; what depends on what else is written, such as
   * whether something replaced it, is worked out from the rows when they are
   * read.
   */
  rows(object: EncodedObject<D, F>, reader: Reader): Iterable<K> | AsyncIterable<K>;
}

/** The rows of an index, each once however many objects give it. */
export interface Rows<K extends Key> {
  /** The rows whose keys start with `prefix`, in the order of their keys. */
  range(prefix: Prefix<K>): AsyncIterable<K>;
}

/**
 * Fills `index` from the objects written to `store` as mine, going through
 * all of them. Only what the user wrote reaches an index: what came from
 * elsewhere is reached by following links from it. Each object is read once
 * and checked against its schema before the index sees it, and the scan
 * fails on one whose data does not fit.
 */
export async function scan<D, K extends Key, F extends Fields<D>>(
  store: Store,
  index: Index<D, K, F>,
): Promise<Rows<K>> {
  const encodings = new Set(index.reads.map(({ encoding }) => encoding));
  const [encoding] = encodings;
  if (encoding === undefined || encodings.size > 1)
    throw new Error("an index reads schemas of one encoding, and at least one");
  const schemas = new Map(index.reads.map((schema) => [schema.link, schema]));
  const rows = new Map<string, K>();
  for await (const link of store.mine()) {
    const bytes = await store.get(link);
    if (bytes === undefined) throw new Error(`the store lists ${link} but does not hold it`);
    const schema = schemas.get(schemaOf(bytes, encoding));
    if (schema === undefined) continue;
    const object = decodeObject(bytes, schema);
    if (object.link !== link) throw new Error(`the store holds another blob under ${link}`);
    for await (const key of index.rows(object, store)) {
      if (!key.every((part) => typeof part === "string" || Number.isFinite(part)))
        throw new Error(`a row of ${link} holds a number that is not finite`);
      rows.set(JSON.stringify(key), Object.freeze([...key]) as K);
    }
  }
  return new SortedRows([...rows.values()].sort(compare));
}

class SortedRows<K extends Key> implements Rows<K> {
  readonly #rows: readonly K[];

  constructor(rows: readonly K[]) {
    this.#rows = rows;
  }

  async *range(prefix: Prefix<K>): AsyncIterable<K> {
    const start: Key = [...prefix];
    const rows = this.#rows;
    let low = 0;
    for (let high = rows.length; low < high; ) {
      const middle = (low + high) >>> 1;
      if (compare(rows[middle]!, start) < 0) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < rows.length && start.every((part, i) => rows[at]![i] === part); at++)
      yield rows[at]!;
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
