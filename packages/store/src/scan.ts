import {
  decodeObject,
  type EncodedObject,
  type Fields,
  type Link,
  type Reader,
  type Schema,
  type Selection,
  schemaOf,
} from "@estoc/object";
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

/** A selection with the rows of what it reads an object as. */
interface Part<D, K extends Key> {
  readonly schema: Schema<D>;
  /** The rows of `object`, which is read with `schema`. */
  rows(object: EncodedObject<D>, reader: Reader): AsyncIterable<K>;
}

type Parts<D, K extends Key> = readonly [Part<D, K>, ...Part<D, K>[]];

// `scan` reads the parts of an index, which nothing outside this module can.
let partsOf: <D, K extends Key>(index: Index<D, K>) => Parts<D, K>;

/**
 * What an application keeps of the objects that some selections take among
 * those its user writes, as rows. An index is the set of rows that those
 * objects give, so going through all of them and adding each as it is
 * written come to the same rows, whatever the order and however often an
 * object is added.
 *
 * An index comes only from `indexOver` and `union`, so which objects it
 * reads is said by its selections and not by its rows.
 */
export class Index<D, K extends Key> {
  readonly #parts: Parts<D, K>;

  static {
    partsOf = (index) => index.#parts;
  }

  /** @throws when the parts read schemas of more than one encoding. */
  constructor(parts: Parts<D, K>) {
    const [{ schema }] = parts;
    if (parts.some((part) => part.schema.encoding !== schema.encoding))
      throw new Error("an index reads schemas of one encoding");
    this.#parts = parts;
  }

  /**
   * The index of the objects that this index and `others` read, with the
   * rows that each of them gives. Each selection reads its own objects and
   * hands what it reads them as to its own rows, so two selections of one
   * schema each give the rows of what they read.
   *
   * @throws when the indexes read schemas of more than one encoding.
   */
  union(...others: readonly Index<D, K>[]): Index<D, K> {
    return new Index([...this.#parts, ...others.flatMap((other) => other.#parts)]);
  }
}

/**
 * The index of the objects that `selection` takes, with the rows that `rows` gives of what it
 * reads each one as. The rows depend on the object and its closure, which `reader` gives by link,
 * and on nothing else; what depends on what else is written, such as whether something replaced
 * the object, is worked out from the rows when they are read.
 */
export function indexOver<D, K extends Key, T, F extends Fields<D>>(
  selection: Selection<D, T, F>,
  rows: (item: T, reader: Reader) => Iterable<K> | AsyncIterable<K>,
): Index<D, K> {
  return new Index([
    {
      schema: selection.schema,
      async *rows(object, reader) {
        const item = await selection.read(object as EncodedObject<D, F>, reader);
        if (item !== undefined) yield* rows(item, reader);
      },
    },
  ]);
}

/** The rows of an index, each once however many objects give it. */
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
 * - Each record is read once, and validated once against each schema it is read with before a
 *   selection sees it.
 * - Within one record, a blob is read from the store once, however many selections and rows read
 *   it.
 *
 * @throws when the data of an object does not fit its schema.
 * @throws when a row holds a number that is not finite.
 */
export async function scan<D, K extends Key>(
  store: Pick<Store, "get" | "records">,
  index: Index<D, K>,
): Promise<Rows<K>> {
  const parts = partsOf(index);
  const { encoding } = parts[0].schema;
  const rows = new Map<string, K>();
  for await (const link of store.records()) {
    const bytes = await store.get(link);
    if (bytes === undefined) throw new Error(`the store lists ${link} but does not hold it`);
    const schema = schemaOf(bytes, encoding);
    const objects = new Map<Schema<D>, EncodedObject<D>>();
    const reader = readerOnce(store);
    for (const part of parts) {
      if (part.schema.link !== schema) continue;
      const object = objects.get(part.schema) ?? decodeObject(bytes, part.schema);
      objects.set(part.schema, object);
      for await (const key of part.rows(object, reader)) {
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
