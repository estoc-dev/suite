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
import type { Backend, Store } from "./store.ts";

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

type Part<K extends Key> = (blob: ScannedBlob) => AsyncIterable<K>;

interface Parts<K extends Key> {
  readonly records: readonly Part<K>[];
  readonly blobs: readonly Part<K>[];
}

// `scan` reads the parts of an index, which nothing outside this module can.
let partsOf: <K extends Key>(index: Index<K>) => Parts<K>;

/**
 * What an application keeps of what some selections take from a store, as rows: of the records its
 * user writes, or, for an index over blobs, of the blobs the store holds.
 *
 * - An index is the set of rows that those give, so going through all of them and adding each as it
 *   is written come to the same rows, whatever the order and however often one is added.
 * - An index comes only from `indexOver`, `indexOverBlobs` and `union`, so what it reads is said by
 *   its selections and not by its rows.
 */
export class Index<K extends Key> {
  readonly #parts: Parts<K>;

  static {
    partsOf = (index) => index.#parts;
  }

  constructor(parts: Parts<K>) {
    this.#parts = parts;
  }

  /**
   * The index of what this index and `others` read, with the rows that each of them gives. Each
   * selection reads its own records or blobs and hands what it reads them as to its own rows, so
   * two selections that take one record each give the rows of what they read.
   */
  union(...others: readonly Index<K>[]): Index<K> {
    const parts = [this, ...others].map((index) => index.#parts);
    return new Index({ records: parts.flatMap(({ records }) => records), blobs: parts.flatMap(({ blobs }) => blobs) });
  }
}

/**
 * The index of the records that `selection` takes, with the rows that `rows` gives of what it
 * reads each one as.
 *
 * - The rows depend on the record and its closure, which `reader` gives by link, and on nothing
 *   else; what depends on what else is written, such as whether something replaced the record, is
 *   worked out from the rows when they are read.
 * - `reader` throws for a blob the store fails to give, and a scan of the index fails with that
 *   even where `selection` or `rows` catch it, such as to give no row of something that came from
 *   elsewhere and does not read as they expect.
 */
export function indexOver<K extends Key, T>(
  selection: Selection<T>,
  rows: (item: T, reader: Reader) => Iterable<K> | AsyncIterable<K>,
): Index<K> {
  return new Index({
    records: [
      async function* (record) {
        const item = await itemOf(selection, record);
        if (item !== undefined) yield* rows(item, record.reader);
      },
    ],
    blobs: [],
  });
}

/**
 * The index of the blobs a store holds that read as objects of the schema of `selection`, records
 * or not, with the rows that `rows` gives of what it reads each one as.
 *
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A blob gives no row when it is not an object in the encoding of the schema, when it names the
 *   schema and does not fit it, or when `selection` or `rows` throw on it. Anyone can send one, and
 *   a scan that threw on it would fail from then on. A mistake in `selection` or `rows` therefore
 *   shows only as rows that are missing.
 * - `reader` throws as it does for `indexOver`, and a scan of the index still fails with that.
 * - A scan reads every blob the store holds, attachments as well, once for each index.
 */
export function indexOverBlobs<K extends Key, D, T, F extends Fields<D> = Fields<D>>(
  selection: SelectionBySchema<D, T, F>,
  rows: (item: T, reader: Reader) => Iterable<K> | AsyncIterable<K>,
): Index<K> {
  return new Index({
    records: [],
    blobs: [
      async function* (blob) {
        const keys: K[] = [];
        try {
          const object = await blob.objectOf(selection.schema);
          const item = object === undefined ? undefined : await selection.itemOf(object, blob.reader);
          if (item !== undefined) for await (const key of rows(item, blob.reader)) keys.push(key);
        } catch {
          // A store that failed still fails the scan, by the blob's `readFailure`.
          return;
        }
        yield* keys;
      },
    ],
  });
}

/**
 * What `selection` reads `record` as. A selection by schema is handed the record read with its
 * schema, which the other selections by that schema share.
 */
async function itemOf<T>(selection: Selection<T>, record: ScannedBlob): Promise<T | undefined> {
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
 * `StagedStore`, and from all the blobs it holds when the index reads blobs.
 *
 * - Only records reach `indexOver`, and on a staged batch the batch's records as well: what came
 *   from elsewhere is reached by following links from them.
 * - The blobs a store holds reach `indexOverBlobs`, and on a staged batch those that the batch keeps
 *   as well. On a private store, only the blobs kept in it do, as its records are only those
 *   written to it: a blob that the store beside holds is not kept there.
 * - Each selection of the index reads each record from the store, except that a selection by schema
 *   is handed the record read with its schema, and only a record of that schema.
 * - Within one record, a blob, the record among them, is read from the store once, however many
 *   selections and rows read it, and the record is read and validated with a schema once,
 *   however many selections by that schema read it.
 * - A store and a private store keep the rows of each index they are scanned for, so a later scan
 *   reads only the records listed and the blobs put since. A staged batch reads its own on top of
 *   the rows that its store keeps.
 *
 * @throws when the data of a record does not fit the schema of a selection by schema that reads it.
 * @throws where a selection of `indexOver` or its rows throw.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it.
 * @throws when a row holds a number that is not finite.
 * @throws when the index reads blobs and `store` is something else with a `get` and `records`, which
 *   cannot list them.
 */
export async function scan<K extends Key>(store: Pick<Store, "get" | "records">, index: Index<K>): Promise<Rows<K>> {
  if (rowsOf in store) return (store as RowKeeper)[rowsOf](index);
  if (partsOf(index).blobs.length > 0)
    throw new Error("only a store, a private store or a staged batch lists the blobs an index over blobs reads");
  return new SortedRows<K>([]).adding({ records: store.records(), blobs: [] }, store, index);
}

/** The key under which `scan` asks a store for the rows it keeps, which nothing outside this package can. */
export const rowsOf: unique symbol = Symbol("rowsOf");

/** A store that keeps the rows of the indexes it is scanned for. */
export interface RowKeeper {
  [rowsOf]<K extends Key>(index: Index<K>): Promise<SortedRows<K>>;
}

/** The rows kept of an index, with how many records and blobs of a store they are of. */
interface KeptIndex {
  readonly rows: SortedRows<Key>;
  readonly recordCount: number;
  readonly blobCount: number;
}

/**
 * The rows that a store keeps of each index it is scanned for, with how many of its records and
 * blobs they are of, so that a scan reads only those listed since.
 *
 * - The rows of a record or a blob depend on it and its closure alone, and a store only grows, so
 *   the rows of those read before still hold.
 * - The rows are kept for as long as the index is, so a program makes an index once and keeps it.
 * - Scans of one index go one after another, each from where the last left off, and one that fails
 *   leaves the rows as they were.
 */
export class KeptRows {
  readonly #reader: Reader;
  readonly #backend: Pick<Backend, "records" | "blobs">;
  readonly #rowsByIndex = new WeakMap<Index<Key>, Promise<KeptIndex>>();

  /** Keeps rows of what `backend` lists, each read from `reader`. */
  constructor(reader: Reader, backend: Pick<Backend, "records" | "blobs">) {
    this.#reader = reader;
    this.#backend = backend;
  }

  /** The rows of `index` for all the records and blobs listed now. */
  rowsOf<K extends Key>(index: Index<K>): Promise<SortedRows<K>> {
    const previous: Promise<KeptIndex> =
      this.#rowsByIndex.get(index) ?? Promise.resolve({ rows: new SortedRows<Key>([]), recordCount: 0, blobCount: 0 });
    const next = previous.then(async ({ rows, recordCount, blobCount }) => {
      const records: Link<unknown>[] = [];
      for await (const link of this.#backend.records(recordCount)) records.push(link);
      const blobs: Link<unknown>[] = [];
      // A store holds many more blobs than records, and most indexes read none of them.
      if (partsOf(index).blobs.length > 0) for await (const link of this.#backend.blobs(blobCount)) blobs.push(link);
      return {
        rows: await rows.adding({ records, blobs }, this.#reader, index),
        recordCount: recordCount + records.length,
        blobCount: blobCount + blobs.length,
      };
    });
    this.#rowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    // What is kept under an index are rows of its keys.
    return next.then(({ rows }) => rows as SortedRows<K>);
  }
}

/** A record, or another blob a store holds, as the parts of an index read it, so that what they share is done once. */
class ScannedBlob {
  readonly link: Link<unknown>;
  /** The blobs of its closure, each read from the store once. */
  readonly reader: { get(link: Link<unknown>): Promise<Uint8Array> };
  readonly #schemas = new Map<object, Link<unknown>>();
  readonly #objects = new Map<object, unknown>();
  #readFailure: { readonly error: unknown } | undefined;

  constructor(link: Link<unknown>, store: Reader) {
    this.link = link;
    this.reader = readerOnce(async (blob) => {
      try {
        const bytes = await store.get(blob);
        if (bytes === undefined) throw new Error(`the store lists ${link} but does not hold ${blob} of its closure`);
        return bytes;
      } catch (error) {
        this.#readFailure ??= { error };
        throw error;
      }
    });
  }

  /** The first error that reading a blob of its closure threw, whether or not what read it caught it. */
  get readFailure(): { readonly error: unknown } | undefined {
    return this.#readFailure;
  }

  /**
   * The object read with `schema`, or `undefined` when it is written to another schema. The schema
   * it names is read once for each encoding, and the object once for each schema.
   *
   * @throws where `schemaOf` and `decodeObject` throw.
   */
  async objectOf<D, F extends Fields<D>>(schema: Schema<D, F>): Promise<EncodedObject<D, F> | undefined> {
    if (!this.#objects.has(schema)) {
      const bytes = await this.reader.get(this.link);
      const schemaLink = this.#schemas.get(schema.encoding) ?? schemaOf(bytes, schema.encoding);
      this.#schemas.set(schema.encoding, schemaLink);
      this.#objects.set(schema, schemaLink === schema.link ? decodeObject(bytes, schema) : undefined);
    }
    return this.#objects.get(schema) as EncodedObject<D, F> | undefined;
  }
}

/** A reader that gets each blob with `get` once and keeps it: a link names one blob. */
function readerOnce(get: (link: Link<unknown>) => Promise<Uint8Array>): {
  get(link: Link<unknown>): Promise<Uint8Array>;
} {
  const blobs = new Map<Link<unknown>, Promise<Uint8Array>>();
  return {
    get(link) {
      const bytes = blobs.get(link) ?? get(link);
      blobs.set(link, bytes);
      return bytes;
    },
  };
}

type Links = Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>;

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
/** Rows in the order of their keys, each once. */
export class SortedRows<K extends Key> implements Rows<K> {
  readonly #rows: readonly K[];

  constructor(rows: readonly K[]) {
    this.#rows = rows;
  }

  /**
   * These rows with those that `index` gives of `records` and `blobs`, each read from `reader`.
   *
   * @throws as `scan` does.
   */
  async adding(
    { records, blobs }: { readonly records: Links; readonly blobs: Links },
    reader: Reader,
    index: Index<K>,
  ): Promise<SortedRows<K>> {
    const newRows: K[] = [];
    const { records: recordParts, blobs: blobParts } = partsOf(index);
    for (const [links, parts] of [
      [records, recordParts],
      [blobs, blobParts],
    ] as const) {
      for await (const link of links) {
        const blob = new ScannedBlob(link, reader);
        for (const part of parts) {
          for await (const key of part(blob)) {
            if (!key.every((part) => typeof part === "string" || Number.isFinite(part)))
              throw new Error(`a row of ${link} holds a number that is not finite`);
            newRows.push(Object.freeze([...key]) as K);
          }
        }
        const failure = blob.readFailure;
        if (failure !== undefined) throw failure.error;
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
