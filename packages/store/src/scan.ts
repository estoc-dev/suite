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

/** The data of the rows that a selection and its `rows` give of what an index reads. */
type Part<F> = (blob: ScannedBlob) => AsyncIterable<F>;

/** What an index reads: the records of a store, the blobs it holds, or the rows of another index. */
type Source<D> = "records" | "blobs" | Derivation<D, Fields<D>>;

/** What an index is made of: the schema its rows are written to, and what gives them of each source it reads. */
interface Derivation<D, F extends Fields<D>> {
  readonly schema: Schema<D, F>;
  readonly parts: ReadonlyMap<Source<D>, readonly Part<F>[]>;
}

interface Order<D, F extends Fields<D>, By extends FieldNames<F>> {
  readonly index: Index<D, F>;
  readonly by: By;
}

// `scan` reads what an index and an ordered index are made of, which nothing outside this module can.
let derivationOf: <D, F extends Fields<D>>(index: Index<D, F>) => Derivation<D, F>;
let orderOf: <D, F extends Fields<D>, By extends FieldNames<F>>(index: OrderedIndex<D, F, By>) => Order<D, F, By>;

/**
 * What an application keeps of what some selections take from a store, as rows: objects of one
 * schema, derived from the records its user writes, from the blobs the store holds, or from the rows
 * of another index.
 *
 * - An index is the set of rows that those give, so going through all of them and adding each as it
 *   is written come to the same rows, whatever the order and however often one is added.
 * - A row is an object written to the schema of the index, with a link as any object has, so the
 *   same data given twice is one row.
 * - An index comes only from `indexOver` and `union`, so what it reads is said by its source and its
 *   selections and not by its rows.
 * - An index says which rows there are and not in what order: `orderedBy` gives it an order, and
 *   `scan` reads it in one.
 */
export class Index<D, F extends Fields<D>> {
  readonly #derivation: Derivation<D, F>;

  static {
    derivationOf = (index) => index.#derivation;
  }

  constructor(derivation: Derivation<D, F>) {
    this.#derivation = derivation;
  }

  /**
   * The index of what this index and `others` read, with the rows that each of them gives, written
   * to the schema of this index. Each selection reads what its own source lists and hands what it
   * reads that as to its own rows, so two selections that take one record each give the rows of
   * what they read.
   */
  union(...others: readonly Index<D, F>[]): Index<D, F> {
    const parts = new Map<Source<D>, readonly Part<F>[]>();
    for (const index of [this, ...others])
      for (const [source, sourceParts] of index.#derivation.parts)
        parts.set(source, [...(parts.get(source) ?? []), ...sourceParts]);
    return new Index({ schema: this.#derivation.schema, parts });
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
 * The index of what `selection` takes of `source`, with the rows that `rows` gives of what it reads
 * each one as: the data of each row, which the index writes to `schema`.
 *
 * - Over `"records"`, it reads the records of a store. What came from elsewhere is reached by
 *   following links from them.
 * - Over another index, it reads the rows of that index, in whatever order that one is read, and
 *   nothing else: an object of the schema of those rows that the store holds is not one of them.
 *   `reader` gives those rows by link, as it gives what the store holds.
 * - The rows depend on what is read and its closure, which `reader` gives by link, and on nothing
 *   else; what depends on what else is written, such as whether something replaced a record, is
 *   worked out from the rows when they are read.
 * - `reader` throws for a blob the store fails to give, and a scan of the index fails with that
 *   even where `selection` or `rows` catch it, such as to give no row of something that came from
 *   elsewhere and does not read as they expect.
 */
export function indexOver<D, F extends Fields<D>, T, S extends Fields<D> = Fields<D>>(
  source: "records" | Index<D, S>,
  selection: Selection<T>,
  schema: Schema<D, F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<D, F>;
/**
 * The index of the blobs a store holds that read as objects of the schema of `selection`, records
 * or not, with the rows that `rows` gives of what it reads each one as.
 *
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A blob gives no row when it is not an object in the encoding of the schema, when it names the
 *   schema and does not fit it, when `selection` or `rows` throw on it, or when the data of a row
 *   does not fit `schema`. Anyone can send one, and a scan that threw on it would fail
 *   from then on. A mistake in `selection` or `rows` therefore shows only as rows that are missing.
 * - `reader` throws as it does over records, and a scan of the index still fails with that.
 * - A scan reads every blob the store holds, attachments as well, once for each index.
 */
export function indexOver<D, F extends Fields<D>, T, S extends Fields<D> = Fields<D>>(
  source: "blobs",
  selection: SelectionBySchema<D, T, S>,
  schema: Schema<D, F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<D, F>;
export function indexOver<D, F extends Fields<D>, T>(
  source: "records" | "blobs" | Index<D, Fields<D>>,
  selection: Selection<T>,
  schema: Schema<D, F>,
  rows: (item: T, reader: Reader) => Iterable<F> | AsyncIterable<F>,
): Index<D, F> {
  const part: Part<F> = async function* (blob) {
    const item = await itemOf(selection, blob);
    if (item !== undefined) yield* rows(item, blob.reader);
  };
  return new Index({
    schema,
    parts: new Map([[typeof source === "string" ? source : derivationOf(source), [part]]]),
  });
}

/**
 * What `selection` reads `blob` as. A selection by schema is handed the blob read with its schema,
 * which the other selections by that schema share.
 */
async function itemOf<T>(selection: Selection<T>, blob: ScannedBlob): Promise<T | undefined> {
  if (!(selection instanceof SelectionBySchema)) return selection.read(blob.link, blob.reader);
  const object = await blob.objectOf(selection.schema);
  return object === undefined ? undefined : selection.itemOf(object, blob.reader);
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
 * Fills `index` from `store`, which may also be a `PrivateStore` or a `StagedStore`: from all its
 * records, from all the blobs it holds when the index reads blobs, and from all the rows of each
 * index it reads, filled from `store` in the same way.
 *
 * - Only records reach an index over records, and on a staged batch the batch's records as well:
 *   what came from elsewhere is reached by following links from them.
 * - The blobs a store holds reach an index over blobs, and on a staged batch those that the batch
 *   keeps as well. On a private store, only the blobs kept in it do, as its records are only those
 *   written to it: a blob that the store beside holds is not kept there.
 * - Only the rows of an index reach an index over it. They are kept beside the store and are not
 *   blobs of it: its `get` gives none of them, and an index over its blobs reads none.
 * - Each selection of the index reads each record from the store, except that a selection by schema
 *   is handed the record read with its schema, and only a record of that schema. The same goes for
 *   the rows of another index.
 * - Within one record, a blob, the record among them, is read from the store once, however many
 *   selections and rows read it, and the record is read and validated with a schema once,
 *   however many selections by that schema read it.
 * - A store and a private store keep the rows of each index they are scanned for, and those rows in
 *   each order they are scanned in, so a later scan reads only the records listed, the blobs put and
 *   the rows given since. A staged batch reads its own on top of the rows that its store keeps.
 *
 * @throws when the data of a record does not fit the schema of a selection by schema that reads it.
 * @throws where a selection over records or over another index, or its rows, throw, and when the
 *   data of a row they give does not fit the schema of the index.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it.
 * @throws when the index reads blobs, itself or through an index it reads, and `store` is something
 *   else with a `get` and `records`, which cannot list them.
 */
export async function scan<D, F extends Fields<D>, By extends FieldNames<F>>(
  store: Pick<Store, "get" | "records">,
  index: OrderedIndex<D, F, By>,
): Promise<Rows<D, F, By>> {
  if (rowsByIndex in store) return (store as RowKeeper)[rowsByIndex].sortedRowsOf(index);
  if (readsBlobs(derivationOf(orderOf(index).index)))
    throw new Error("only a store, a private store or a staged batch lists the blobs an index over blobs reads");
  const records: Link<unknown>[] = [];
  for await (const link of store.records()) records.push(link);
  return new AddedRows(noRows, { records, blobs: [] }, store).sortedRowsOf(index);
}

function readsBlobs<D>(derivation: Derivation<D, Fields<D>>): boolean {
  return [...derivation.parts.keys()].some(
    (source) => source === "blobs" || (source !== "records" && readsBlobs(source)),
  );
}

/** The key under which `scan` asks a store for the rows it has of each index, which nothing outside this package can. */
export const rowsByIndex: unique symbol = Symbol("rowsByIndex");

/** A store that has the rows of the indexes it is scanned for. */
export interface RowKeeper {
  readonly [rowsByIndex]: RowsByIndex;
}

/** The rows of each index for what one store lists. */
export interface RowsByIndex {
  /** The rows that the index of `derivation` gives, each once. */
  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>>;
  /** The rows of `index` in its order. */
  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>>;
}

/** The rows of each index for a store that lists nothing. */
const noRows: RowsByIndex = {
  derivedObjectsOf: async (derivation) => new DerivedObjects(derivation),
  sortedRowsOf: async (index) => new SortedRows(index),
};

/** The rows kept of an index, with how many records and blobs of a store they are of. */
interface KeptObjects<D, F extends Fields<D>> {
  readonly objects: DerivedObjects<D, F>;
  readonly recordCount: number;
  readonly blobCount: number;
}

/**
 * The rows that a store keeps of each index it is scanned for, with how many of its records and
 * blobs they are of, so that a scan reads only those listed since, and those rows in each order
 * they are scanned in.
 *
 * - The rows of a record, a blob or a row of another index depend on it and its closure alone, and
 *   a store only grows, so the rows of those read before still hold.
 * - The rows of an index are kept once, for its orders and for each index that reads it.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 * - Scans of one index go one after another, each from where the last left off, and one that fails
 *   leaves the rows as they were.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #backend: Pick<Backend, "records" | "blobs">;
  readonly #objectsByDerivation = new WeakMap<object, Promise<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, Promise<unknown>>();

  /** Keeps rows of what `backend` lists, each read from `reader`. */
  constructor(reader: Reader, backend: Pick<Backend, "records" | "blobs">) {
    this.#reader = reader;
    this.#backend = backend;
  }

  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    const derivedObjects = this.derivedObjectsOf(derivationOf(orderOf(index).index));
    // What is kept under an ordered index are rows of it.
    const kept = this.#sortedRowsByIndex.get(index) as Promise<SortedRows<D, F, By>> | undefined;
    const previous = kept ?? Promise.resolve(new SortedRows(index));
    const next = Promise.all([previous, derivedObjects]).then(([sortedRows, objects]) => sortedRows.including(objects));
    this.#sortedRowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    return next;
  }

  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    // What is kept under what an index is made of are rows of it.
    const kept = this.#objectsByDerivation.get(derivation) as Promise<KeptObjects<D, F>> | undefined;
    const previous = kept ?? Promise.resolve({ objects: new DerivedObjects(derivation), recordCount: 0, blobCount: 0 });
    const next = previous.then(async ({ objects, recordCount, blobCount }) => {
      const records: Link<unknown>[] = [];
      if (derivation.parts.has("records"))
        for await (const link of this.#backend.records(recordCount)) records.push(link);
      const blobs: Link<unknown>[] = [];
      // A store holds many more blobs than records, and most indexes read none of them.
      if (derivation.parts.has("blobs")) for await (const link of this.#backend.blobs(blobCount)) blobs.push(link);
      return {
        objects: await objects.adding({ records, blobs }, this.#reader, this),
        recordCount: recordCount + records.length,
        blobCount: blobCount + blobs.length,
      };
    });
    this.#objectsByDerivation.set(
      derivation,
      next.catch(() => previous),
    );
    return next.then(({ objects }) => objects);
  }
}

/**
 * The rows of each index for what a store lists and some records and blobs besides, as for a staged
 * batch: those that `rows` has for the store, then those of `added`, each read from `reader`.
 * Nothing is kept of them.
 */
export class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #added: Listed;
  readonly #reader: Reader;

  constructor(rows: RowsByIndex, added: Listed, reader: Reader) {
    this.#rows = rows;
    this.#added = added;
    this.#reader = reader;
  }

  async sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    // The rows in their order come first, so that those derived next go on from the ones they are of.
    const sortedRows = await this.#rows.sortedRowsOf(index);
    return sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index)));
  }

  async derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    return (await this.#rows.derivedObjectsOf(derivation)).adding(this.#added, this.#reader, this);
  }
}

/**
 * A record, another blob a store holds, or a row of another index, as the parts of an index read
 * it, so that what they share is done once.
 */
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

/** The records and blobs that a store lists, or those it has listed since some rows were derived. */
interface Listed {
  readonly records: Links;
  readonly blobs: Links;
}

/**
 * The rows that an index gives of what a store lists, each once, in the order it first gave them.
 * They are kept beside the store, which does not hold them: an index over this one reads them from
 * here, by link as it reads any blob, and whatever else it reads from the store.
 */
class DerivedObjects<D, F extends Fields<D>> {
  readonly objects: readonly EncodedObject<D, F>[];
  readonly #derivation: Derivation<D, F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>>;
  /** The rows of each index that the index reads, all of which these are of. */
  readonly #sources: ReadonlyMap<Derivation<D, Fields<D>>, DerivedObjects<D, Fields<D>>>;

  constructor(
    derivation: Derivation<D, F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>> = new Map(),
    sources: ReadonlyMap<Derivation<D, Fields<D>>, DerivedObjects<D, Fields<D>>> = new Map(),
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.#objectsByLink = objectsByLink;
    this.#sources = sources;
  }

  /**
   * These rows, then those that the index gives of `records` and `blobs`, each read from `store`,
   * and of the rows that each index it reads has in `rows` beyond those these are of.
   *
   * @throws as `scan` does.
   */
  async adding({ records, blobs }: Listed, store: Reader, rows: RowsByIndex): Promise<DerivedObjects<D, F>> {
    const { schema, parts } = this.#derivation;
    const objectsByLink = new Map(this.#objectsByLink);
    const sources = new Map<Derivation<D, Fields<D>>, DerivedObjects<D, Fields<D>>>();
    for (const [source, sourceParts] of parts) {
      let links: Links;
      let reader = store;
      if (source === "records") links = records;
      else if (source === "blobs") links = blobs;
      else {
        const derivedObjects = await rows.derivedObjectsOf(source);
        const readCount = this.#sources.get(source)?.objects.length ?? 0;
        links = derivedObjects.objects.slice(readCount).map(({ link }) => link);
        reader = derivedObjects.readerOver(store);
        sources.set(source, derivedObjects);
      }
      for await (const link of links) {
        const blob = new ScannedBlob(link, reader);
        for (const part of sourceParts) {
          const partObjects: EncodedObject<D, F>[] = [];
          try {
            for await (const data of part(blob)) partObjects.push(encodeObject(schema, data));
          } catch (error) {
            // Anyone can send a blob, and a scan that threw on one would fail from then on.
            // A store that failed still fails the scan, by the blob's `readFailure`.
            if (source !== "blobs") throw error;
            continue;
          }
          for (const object of partObjects) if (!objectsByLink.has(object.link)) objectsByLink.set(object.link, object);
        }
        const failure = blob.readFailure;
        if (failure !== undefined) throw failure.error;
      }
    }
    const isSame =
      objectsByLink.size === this.#objectsByLink.size &&
      [...sources].every(([source, derivedObjects]) => this.#sources.get(source) === derivedObjects);
    return isSame ? this : new DerivedObjects(this.#derivation, objectsByLink, sources);
  }

  /** A reader of these rows and of those they were derived from, and of what `store` holds besides. */
  readerOver(store: Reader): Reader {
    return { get: (link) => this.#bytesOf(link) ?? store.get(link) };
  }

  #bytesOf(link: Link<unknown>): Uint8Array | undefined {
    const object = this.#objectsByLink.get(link);
    if (object !== undefined) return object.bytes;
    for (const source of this.#sources.values()) {
      const bytes = source.#bytesOf(link);
      if (bytes !== undefined) return bytes;
    }
    return undefined;
  }
}

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
/** The rows of an ordered index in its order. */
export class SortedRows<D, F extends Fields<D>, By extends FieldNames<F>> implements Rows<D, F, By> {
  readonly #index: OrderedIndex<D, F, By>;
  readonly #derivedObjects: DerivedObjects<D, F>;
  readonly #rows: readonly KeyedRow<D, F>[];

  constructor(
    index: OrderedIndex<D, F, By>,
    derivedObjects: DerivedObjects<D, F> = new DerivedObjects(derivationOf(orderOf(index).index)),
    rows: readonly KeyedRow<D, F>[] = [],
  ) {
    this.#index = index;
    this.#derivedObjects = derivedObjects;
    this.#rows = rows;
  }

  /** The rows of `derivedObjects` in the order: those these are of, then any the index gave after them. */
  including(derivedObjects: DerivedObjects<D, F>): SortedRows<D, F, By> {
    const newRows = derivedObjects.objects.slice(this.#derivedObjects.objects.length);
    if (newRows.length === 0) return this;
    const { index, by } = orderOf(this.#index);
    const { encoding } = derivationOf(index).schema;
    const keyedRows = newRows.map((row) => {
      const data: Fields<D> = row.data;
      // A row that leaves a field out does not hold what every object inherits under its name, such as `constructor`.
      const key = by.map((name) => keyPartOf(Object.hasOwn(data, name) ? data[name] : undefined, encoding));
      return { key, row };
    });
    return new SortedRows(
      this.#index,
      derivedObjects,
      [...this.#rows, ...keyedRows].sort((a, b) => compareKeys(a.key, b.key) || compareParts(a.row.link, b.row.link)),
    );
  }

  async *range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<D, F>> {
    const { encoding } = derivationOf(orderOf(this.#index).index).schema;
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
