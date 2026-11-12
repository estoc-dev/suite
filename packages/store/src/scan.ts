import {
  decodeObject,
  type EncodedObject,
  type Encoding,
  encodeObject,
  type Fields,
  type Link,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
  schemaOf,
} from "@estoc/object";
import type { Backend, Store } from "./store.ts";

/** The names of fields of the data `F`. */
export type FieldNames<F> = readonly (keyof F & string)[];

/** The key of a row of the data `F`: what it holds in the fields `By`, in that order. */
export type KeyOf<F, By extends FieldNames<F>> = {
  readonly [At in keyof By]: By[At] extends keyof F ? F[By[At]] : never;
};

/**
 * The keys that start a key of `K`, from none of it to all of it. The empty
 * prefix stands outside the condition, so that it fits even a `K` that is
 * still a type parameter.
 */
export type Prefix<K extends readonly unknown[]> =
  | readonly []
  | (K extends readonly [infer First, ...infer Rest] ? readonly [First, ...Prefix<Rest>] : K);

type Part<D, F extends Fields<D>> = (blob: ScannedBlob, schema: Schema<D, F>) => AsyncIterable<EncodedObject<D, F>>;

interface Parts<D, F extends Fields<D>> {
  readonly records: readonly Part<D, F>[];
  readonly blobs: readonly Part<D, F>[];
}

interface IndexContent<D, F extends Fields<D>> {
  readonly schema: Schema<D, F>;
  readonly parts: Parts<D, F>;
}

interface Order<D, F extends Fields<D>, By extends FieldNames<F>> {
  readonly index: Index<D, F>;
  readonly by: By;
}

// `scan` reads what an index and an ordered index are made of, which nothing outside this module can.
let contentOf: <D, F extends Fields<D>>(index: Index<D, F>) => IndexContent<D, F>;
let orderOf: <D, F extends Fields<D>, By extends FieldNames<F>>(index: OrderedIndex<D, F, By>) => Order<D, F, By>;

/**
 * What an application keeps of what some selections take from a store, as rows: objects of one
 * schema, derived from the records its user writes, or, for an index over blobs, from the blobs the
 * store holds.
 *
 * - An index is the set of rows that those give, so going through all of them and adding each as it
 *   is written come to the same rows, whatever the order and however often one is added.
 * - A row is an object written to the schema of the index, with a link as any object has, so the
 *   same data given twice is one row.
 * - An index comes only from `indexOver`, `indexOverBlobs` and `union`, so what it reads is said by
 *   its selections and not by its rows.
 * - An index says which rows there are and not in what order: `orderedBy` gives it an order, and
 *   `scan` reads it in one.
 */
export class Index<D, F extends Fields<D>> {
  readonly #content: IndexContent<D, F>;

  static {
    contentOf = (index) => index.#content;
  }

  constructor(content: IndexContent<D, F>) {
    this.#content = content;
  }

  /**
   * The index of what this index and `others` read, with the rows that each of them gives, written
   * to the schema of this index. Each selection reads its own records or blobs and hands what it
   * reads them as to its own rows, so two selections that take one record each give the rows of
   * what they read.
   */
  union(...others: readonly Index<D, F>[]): Index<D, F> {
    const parts = [this, ...others].map((index) => index.#content.parts);
    return new Index({
      schema: this.#content.schema,
      parts: { records: parts.flatMap(({ records }) => records), blobs: parts.flatMap(({ blobs }) => blobs) },
    });
  }

  /**
   * This index with its rows in the order of their fields `by`, which `scan` gives ranges of.
   *
   * - The first field counts most. Rows that hold the same in all of them are in the order of their
   *   links.
   * - A field that a row leaves out comes before any value. Numbers are in their order, strings in
   *   the order of their code units, and any other value, such as a link, in the order of its bytes
   *   in the encoding.
   * - The orders of one index share its rows, so a store that keeps them reads each record once
   *   however many orders it is scanned in.
   */
  orderedBy<const By extends FieldNames<F>>(...by: By): OrderedIndex<D, F, By> {
    return new OrderedIndex({ index: this, by });
  }
}

/** An index with its rows in the order of some of their fields, from `orderedBy`. */
export class OrderedIndex<D, F extends Fields<D>, By extends FieldNames<F>> {
  readonly #order: Order<D, F, By>;

  static {
    orderOf = (index) => index.#order;
  }

  constructor(order: Order<D, F, By>) {
    this.#order = order;
  }
}

/**
 * The index of the records that `selection` takes, with the rows that `rows` gives of what it
 * reads each one as: the data of each row, which the index writes to `schema`.
 *
 * - The rows depend on the record and its closure, which `reader` gives by link, and on nothing
 *   else; what depends on what else is written, such as whether something replaced the record, is
 *   worked out from the rows when they are read.
 * - `reader` throws for a blob the store fails to give, and a scan of the index fails with that
 *   even where `selection` or `rows` catch it, such as to give no row of something that came from
 *   elsewhere and does not read as they expect.
 */
export function indexOver<D, F extends Fields<D>, T>(
  selection: Selection<T>,
  schema: Schema<D, F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<D, F> {
  return new Index({
    schema,
    parts: {
      records: [
        async function* (record, schema) {
          const item = await itemOf(selection, record);
          if (item === undefined) return;
          for await (const data of rows(item, record.reader)) yield encodeObject(schema, data);
        },
      ],
      blobs: [],
    },
  });
}

/**
 * The index of the blobs a store holds that read as objects of the schema of `selection`, records
 * or not, with the rows that `rows` gives of what it reads each one as, as for `indexOver`.
 *
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A blob gives no row when it is not an object in the encoding of the schema, when it names the
 *   schema and does not fit it, when `selection` or `rows` throw on it, or when the data of a row
 *   does not fit `schema`. Anyone can send one, and a scan that threw on it would fail
 *   from then on. A mistake in `selection` or `rows` therefore shows only as rows that are missing.
 * - `reader` throws as it does for `indexOver`, and a scan of the index still fails with that.
 * - A scan reads every blob the store holds, attachments as well, once for each index.
 */
export function indexOverBlobs<D, F extends Fields<D>, T, S extends Fields<D> = Fields<D>>(
  selection: SelectionBySchema<D, T, S>,
  schema: Schema<D, F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<D, F> {
  return new Index({
    schema,
    parts: {
      records: [],
      blobs: [
        async function* (blob, schema) {
          const blobRows: EncodedObject<D, F>[] = [];
          try {
            const object = await blob.objectOf(selection.schema);
            const item = object === undefined ? undefined : await selection.itemOf(object, blob.reader);
            if (item !== undefined)
              for await (const data of rows(item, blob.reader)) blobRows.push(encodeObject(schema, data));
          } catch {
            // A store that failed still fails the scan, by the blob's `readFailure`.
            return;
          }
          yield* blobRows;
        },
      ],
    },
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

/** The rows of an ordered index, each once however many records give it. */
export interface Rows<D, F extends Fields<D>, By extends FieldNames<F>> {
  /**
   * The rows that hold `prefix` in the first fields of the order, one value for each, in the order of
   * the index.
   */
  range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<D, F>>;
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
 * - A store and a private store keep the rows of each index they are scanned for, and those rows in
 *   each order they are scanned in, so a later scan reads only the records listed and the blobs put
 *   since. A staged batch reads its own on top of the rows that its store keeps.
 *
 * @throws when the data of a record does not fit the schema of a selection by schema that reads it.
 * @throws where a selection of `indexOver` or its rows throw, and when the data of a row they give
 *   does not fit the schema of the index.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it.
 * @throws when the index reads blobs and `store` is something else with a `get` and `records`, which
 *   cannot list them.
 */
export async function scan<D, F extends Fields<D>, By extends FieldNames<F>>(
  store: Pick<Store, "get" | "records">,
  index: OrderedIndex<D, F, By>,
): Promise<Rows<D, F, By>> {
  if (rowsOf in store) return (store as RowKeeper)[rowsOf](index);
  if (contentOf(orderOf(index).index).parts.blobs.length > 0)
    throw new Error("only a store, a private store or a staged batch lists the blobs an index over blobs reads");
  return new SortedRows(index).adding({ records: store.records(), blobs: [] }, store);
}

/** The key under which `scan` asks a store for the rows it keeps, which nothing outside this package can. */
export const rowsOf: unique symbol = Symbol("rowsOf");

/** A store that keeps the rows of the indexes it is scanned for. */
export interface RowKeeper {
  [rowsOf]<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>>;
}

/** The rows kept of an index, with how many records and blobs of a store they are of. */
interface KeptIndex<D, F extends Fields<D>> {
  readonly rows: DerivedRows<D, F>;
  readonly recordCount: number;
  readonly blobCount: number;
}

/**
 * The rows that a store keeps of each index it is scanned for, with how many of its records and
 * blobs they are of, so that a scan reads only those listed since, and those rows in each order
 * they are scanned in.
 *
 * - The rows of a record or a blob depend on it and its closure alone, and a store only grows, so
 *   the rows of those read before still hold.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 * - Scans of one index go one after another, each from where the last left off, and one that fails
 *   leaves the rows as they were.
 */
export class KeptRows {
  readonly #reader: Reader;
  readonly #backend: Pick<Backend, "records" | "blobs">;
  readonly #rowsByIndex = new WeakMap<object, Promise<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, Promise<unknown>>();

  /** Keeps rows of what `backend` lists, each read from `reader`. */
  constructor(reader: Reader, backend: Pick<Backend, "records" | "blobs">) {
    this.#reader = reader;
    this.#backend = backend;
  }

  /** The rows of `index` for all the records and blobs listed now. */
  rowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    const derivedRows = this.#derivedRowsOf(orderOf(index).index);
    // What is kept under an ordered index are rows of it.
    const kept = this.#sortedRowsByIndex.get(index) as Promise<SortedRows<D, F, By>> | undefined;
    const previous = kept ?? Promise.resolve(new SortedRows(index));
    const next = Promise.all([previous, derivedRows]).then(([sortedRows, rows]) => sortedRows.including(rows));
    this.#sortedRowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    return next;
  }

  #derivedRowsOf<D, F extends Fields<D>>(index: Index<D, F>): Promise<DerivedRows<D, F>> {
    // What is kept under an index are rows of it.
    const kept = this.#rowsByIndex.get(index) as Promise<KeptIndex<D, F>> | undefined;
    const previous = kept ?? Promise.resolve({ rows: new DerivedRows(index), recordCount: 0, blobCount: 0 });
    const next = previous.then(async ({ rows, recordCount, blobCount }) => {
      const records: Link<unknown>[] = [];
      for await (const link of this.#backend.records(recordCount)) records.push(link);
      const blobs: Link<unknown>[] = [];
      // A store holds many more blobs than records, and most indexes read none of them.
      if (contentOf(index).parts.blobs.length > 0)
        for await (const link of this.#backend.blobs(blobCount)) blobs.push(link);
      return {
        rows: await rows.adding({ records, blobs }, this.#reader),
        recordCount: recordCount + records.length,
        blobCount: blobCount + blobs.length,
      };
    });
    this.#rowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    return next.then(({ rows }) => rows);
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

/** What a row holds in a field of the order, as rows are compared by it. */
type KeyPart = number | string | Uint8Array | undefined;

interface KeyedRow<D, F extends Fields<D>> {
  readonly key: readonly KeyPart[];
  readonly row: EncodedObject<D, F>;
}

interface Listed {
  readonly records: Links;
  readonly blobs: Links;
}

/** The rows that an index gives of some records and blobs, each once, in the order it first gave them. */
class DerivedRows<D, F extends Fields<D>> {
  readonly rows: readonly EncodedObject<D, F>[];
  readonly #index: Index<D, F>;
  readonly #links: ReadonlySet<Link<unknown>>;

  constructor(
    index: Index<D, F>,
    rows: readonly EncodedObject<D, F>[] = [],
    links: ReadonlySet<Link<unknown>> = new Set(),
  ) {
    this.#index = index;
    this.rows = rows;
    this.#links = links;
  }

  /**
   * These rows, then those that the index gives of `records` and `blobs`, each read from `reader`.
   *
   * @throws as `scan` does.
   */
  async adding({ records, blobs }: Listed, reader: Reader): Promise<DerivedRows<D, F>> {
    const newRows: EncodedObject<D, F>[] = [];
    const newLinks = new Set<Link<unknown>>();
    const { schema, parts } = contentOf(this.#index);
    for (const [links, linkParts] of [
      [records, parts.records],
      [blobs, parts.blobs],
    ] as const) {
      for await (const link of links) {
        const blob = new ScannedBlob(link, reader);
        for (const part of linkParts) {
          for await (const row of part(blob, schema)) {
            if (this.#links.has(row.link) || newLinks.has(row.link)) continue;
            newLinks.add(row.link);
            newRows.push(row);
          }
        }
        const failure = blob.readFailure;
        if (failure !== undefined) throw failure.error;
      }
    }
    if (newRows.length === 0) return this;
    return new DerivedRows(this.#index, [...this.rows, ...newRows], new Set([...this.#links, ...newLinks]));
  }
}

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
/** The rows of an ordered index in its order. */
export class SortedRows<D, F extends Fields<D>, By extends FieldNames<F>> implements Rows<D, F, By> {
  readonly #index: OrderedIndex<D, F, By>;
  readonly #derivedRows: DerivedRows<D, F>;
  readonly #rows: readonly KeyedRow<D, F>[];

  constructor(
    index: OrderedIndex<D, F, By>,
    derivedRows: DerivedRows<D, F> = new DerivedRows(orderOf(index).index),
    rows: readonly KeyedRow<D, F>[] = [],
  ) {
    this.#index = index;
    this.#derivedRows = derivedRows;
    this.#rows = rows;
  }

  /**
   * These rows with those that the index gives of `records` and `blobs`, each read from `reader`.
   *
   * @throws as `scan` does.
   */
  async adding(listed: Listed, reader: Reader): Promise<SortedRows<D, F, By>> {
    return this.including(await this.#derivedRows.adding(listed, reader));
  }

  /** The rows of `derivedRows` in the order: those these are of, then any the index gave after them. */
  including(derivedRows: DerivedRows<D, F>): SortedRows<D, F, By> {
    const newRows = derivedRows.rows.slice(this.#derivedRows.rows.length);
    if (newRows.length === 0) return this;
    const { index, by } = orderOf(this.#index);
    const { encoding } = contentOf(index).schema;
    const keyedRows = newRows.map((row) => {
      const data: Fields<D> = row.data;
      return { key: by.map((name) => keyPartOf(data[name], encoding)), row };
    });
    return new SortedRows(
      this.#index,
      derivedRows,
      [...this.#rows, ...keyedRows].sort((a, b) => compareKeys(a.key, b.key) || compareParts(a.row.link, b.row.link)),
    );
  }

  async *range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<D, F>> {
    const { encoding } = contentOf(orderOf(this.#index).index).schema;
    const start = prefix.map((value) => keyPartOf(value as D | undefined, encoding));
    const rows = this.#rows;
    let low = 0;
    for (let high = rows.length; low < high; ) {
      const middle = (low + high) >>> 1;
      if (compareKeys(rows[middle]!.key, start) < 0) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < rows.length && compareKeys(rows[at]!.key.slice(0, start.length), start) === 0; at++)
      yield rows[at]!.row;
  }
}

function keyPartOf<D>(value: D | undefined, encoding: Encoding<D>): KeyPart {
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  return encoding.encode(value);
}

/** A key comes before every longer key that starts with it. */
function compareKeys(a: readonly KeyPart[], b: readonly KeyPart[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const order = compareParts(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function compareParts(a: KeyPart, b: KeyPart): number {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  }
  if (typeof a !== typeof b) return rankOf(a) - rankOf(b);
  return a === b ? 0 : (a as number | string) < (b as number | string) ? -1 : 1;
}

function rankOf(part: KeyPart): number {
  return part === undefined ? 0 : typeof part === "number" ? 1 : typeof part === "string" ? 2 : 3;
}
// biome-ignore-end lint/style/noNonNullAssertion: each index is below the length it is checked against
