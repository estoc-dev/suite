import {
  decodeObject,
  type EncodedObject,
  type Fields,
  type Link,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
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

type Part<K extends Key> = (record: ScannedRecord) => AsyncIterable<K>;

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
    async function* (record) {
      const item = await itemOf(selection, record);
      if (item !== undefined) yield* rows(item, record.reader);
    },
  ]);
}

/**
 * What `selection` reads `record` as. A selection by schema is handed the record read with its
 * schema, which the other selections by that schema share.
 */
async function itemOf<T>(selection: Selection<T>, record: ScannedRecord): Promise<T | undefined> {
  if (!(selection instanceof SelectionBySchema)) return selection.read(record.link, record.reader);
  const object = await record.objectOf(selection.schema);
  return object === undefined ? undefined : selection.itemOf(object, record.reader);
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
 * - Each selection of the index reads each record from the store, except that a selection by schema
 *   is handed the record read with its schema, and only a record of that schema.
 * - Within one record, a blob, the record among them, is read from the store once, however many
 *   selections and rows read it, and the record is read and validated with a schema once,
 *   however many selections by that schema read it.
 * - A store and a private store keep the rows of each index they are scanned for, so a later scan
 *   reads only the records listed since. A staged batch reads its own records on top of the rows
 *   that its store keeps.
 *
 * @throws when the data of a record does not fit the schema of a selection by schema that reads it.
 * @throws where a selection or its rows throw.
 * @throws when a row holds a number that is not finite.
 */
export async function scan<K extends Key>(store: Pick<Store, "get" | "records">, index: Index<K>): Promise<Rows<K>> {
  if (rowsOf in store) return (store as RowKeeper)[rowsOf](index);
  return new SortedRows<K>([]).adding(store.records(), store, index);
}

/** The key under which `scan` asks a store for the rows it keeps, which nothing outside this package can. */
export const rowsOf: unique symbol = Symbol("rowsOf");

/** A store that keeps the rows of the indexes it is scanned for. */
export interface RowKeeper {
  [rowsOf]<K extends Key>(index: Index<K>): Promise<SortedRows<K>>;
}

/**
 * The rows that a store keeps of each index it is scanned for, with how many of its records they
 * are of, so that a scan reads only the records listed since.
 *
 * - The rows of a record depend on it and its closure alone, and a store only grows, so the rows of
 *   the records read before still hold.
 * - The rows are kept for as long as the index is, so a program makes an index once and keeps it.
 * - Scans of one index go one after another, each from where the last left off, and one that fails
 *   leaves the rows as they were.
 */
export class KeptRows {
  readonly #reader: Reader;
  readonly #records: (start: number) => AsyncIterable<Link<unknown>>;
  readonly #rowsByIndex = new WeakMap<Index<Key>, Promise<{ rows: SortedRows<Key>; count: number }>>();

  /**
   * Keeps rows of the records that `records(start)` gives in the order they were listed, leaving out
   * the first `start`, each read from `reader`.
   */
  constructor(reader: Reader, records: (start: number) => AsyncIterable<Link<unknown>>) {
    this.#reader = reader;
    this.#records = records;
  }

  /** The rows of `index` for all the records listed now. */
  rowsOf<K extends Key>(index: Index<K>): Promise<SortedRows<K>> {
    const previous = this.#rowsByIndex.get(index) ?? Promise.resolve({ rows: new SortedRows<Key>([]), count: 0 });
    const next = previous.then(async ({ rows, count }) => {
      const records: Link<unknown>[] = [];
      for await (const link of this.#records(count)) records.push(link);
      return { rows: await rows.adding(records, this.#reader, index), count: count + records.length };
    });
    this.#rowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    // What is kept under an index are rows of its keys.
    return next.then(({ rows }) => rows as SortedRows<K>);
  }
}

/** A record as the parts of an index read it, so that what they share is done once. */
class ScannedRecord {
  readonly link: Link<unknown>;
  readonly reader: Reader;
  readonly #schemas = new Map<object, Link<unknown>>();
  readonly #objects = new Map<object, unknown>();

  constructor(link: Link<unknown>, store: Reader) {
    this.link = link;
    this.reader = readerOnce(store);
  }

  /**
   * The record read with `schema`, or `undefined` when it is written to another schema. The schema
   * it names is read once for each encoding, and the record once for each schema.
   */
  async objectOf<D, F extends Fields<D>>(schema: Schema<D, F>): Promise<EncodedObject<D, F> | undefined> {
    if (!this.#objects.has(schema)) {
      const bytes = await this.reader.get(this.link);
      if (bytes === undefined) throw new Error(`the store lists ${this.link} but does not hold it`);
      const named = this.#schemas.get(schema.encoding) ?? schemaOf(bytes, schema.encoding);
      this.#schemas.set(schema.encoding, named);
      this.#objects.set(schema, named === schema.link ? decodeObject(bytes, schema) : undefined);
    }
    return this.#objects.get(schema) as EncodedObject<D, F> | undefined;
  }
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

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
/** Rows in the order of their keys, each once. */
export class SortedRows<K extends Key> implements Rows<K> {
  readonly #rows: readonly K[];

  constructor(rows: readonly K[]) {
    this.#rows = rows;
  }

  /**
   * These rows with those that `index` gives of `records`, each record read from `reader`.
   *
   * @throws as `scan` does.
   */
  async adding(
    records: Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>,
    reader: Reader,
    index: Index<K>,
  ): Promise<SortedRows<K>> {
    const newRows: K[] = [];
    for await (const link of records) {
      const record = new ScannedRecord(link, reader);
      for (const part of partsOf(index)) {
        for await (const key of part(record)) {
          if (!key.every((part) => typeof part === "string" || Number.isFinite(part)))
            throw new Error(`a row of ${link} holds a number that is not finite`);
          newRows.push(Object.freeze([...key]) as K);
        }
      }
    }
    if (newRows.length === 0) return this;
    const rows = [...this.#rows, ...newRows].sort(compare);
    return new SortedRows(rows.filter((row, at) => at === 0 || compare(rows[at - 1]!, row) !== 0));
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
