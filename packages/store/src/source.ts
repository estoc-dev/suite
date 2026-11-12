import {
  type EncodedObject,
  type Link,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
  type ValueMap,
} from "@estoc/object";
import type { RowsByIndex } from "./scan.ts";
import type { ScannedBlob } from "./scanned-blob.ts";

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

/** The data of the rows that a source and the `rows` of an index give of what the index reads. */
type Part<F> = (blob: ScannedBlob) => AsyncIterable<F>;

/** Where what an index reads is listed: the records of a store, the blobs it holds, or the rows of another index. */
export interface Origin {
  /** Whether it lists the blobs a store holds, itself or through an index it reads. */
  readonly readsBlobs: boolean;
  listingIn(rows: RowsByIndex): Promise<Listing>;
}

/**
 * Something that an index read and that one of its sources gave no rows of: the source or its
 * `rows` threw on it, or gave a row whose data does not fit the schema of the index. The rows of
 * the index are short of whatever it would have given.
 */
export interface ItemFailure {
  /** The link of the record, the blob or the row of another index that was read. */
  readonly item: Link<unknown>;
  readonly error: unknown;
}

/** What an origin lists for one store, in the order it listed them. A later one starts with these. */
export interface Listing {
  readonly links: readonly Link<unknown>[];
  /** What the index that derived these failed on, itself or through an index it reads. A store fails on none. */
  readonly failures: readonly ItemFailure[];
  /** One of them as the object an index derived, which is handed on without being read and validated again. */
  objectOf(link: Link<unknown>): { readonly schema: object } | undefined;
  /**
   * The bytes of a blob that the store does not hold: one of them, a blob of the closure of the
   * schema it is written to, or either of one that such a one was derived from.
   */
  bytesOf(link: Link<unknown>): Uint8Array | undefined;
}

const listedRecords: Origin = {
  readsBlobs: false,
  listingIn: (rows) => rows.listedRecords(),
};

const heldBlobs: Origin = {
  readsBlobs: true,
  listingIn: (rows) => rows.heldBlobs(),
};

interface Reading<T> {
  readonly origin: Origin;
  /** Gives `undefined` for one the source leaves out. */
  itemOf(blob: ScannedBlob): Promise<T | undefined>;
}

/** What an index is made of: the schema its rows are written to, and what gives them of what each origin lists. */
export class Derivation<F extends ValueMap> implements Origin {
  readonly schema: Schema<F>;
  readonly parts: ReadonlyMap<Origin, readonly Part<F>[]>;
  readonly readsBlobs: boolean;

  constructor(schema: Schema<F>, parts: ReadonlyMap<Origin, readonly Part<F>[]>) {
    this.schema = schema;
    this.parts = parts;
    this.readsBlobs = [...parts.keys()].some((origin) => origin.readsBlobs);
  }

  listingIn(rows: RowsByIndex): Promise<Listing> {
    return rows.derivedObjectsOf(this);
  }
}

interface Order<F extends ValueMap, By extends FieldNames<F>> {
  readonly index: Index<F>;
  readonly by: By;
}

// `indexOver` and `scan` read what a source, an index and an ordered index are made of, which nothing
// outside this package can.
let readingOf: <T>(source: Source<T>) => Reading<T>;
export let derivationOf: <F extends ValueMap>(index: Index<F>) => Derivation<F>;
export let orderOf: <F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>) => Order<F, By>;

/**
 * What an index reads, each read as a `T`: the records or the blobs of a store that a selection
 * takes, from `selectedRecords` and `selectedBlobs`, or the rows of another index, which is itself a
 * source.
 *
 * Where things are listed and what each is read as go together. A reading that trusts what an index
 * derived holds only over the rows of that index, so it is given as a source of those rows, and not
 * as a selection that fits any listing.
 */
export class Source<T> {
  readonly #reading: Reading<T>;

  static {
    readingOf = (source) => source.#reading;
  }

  constructor(reading: Reading<T>) {
    this.#reading = reading;
  }
}

/**
 * The records of a store that `selection` takes, each as what it reads it as. What came from
 * elsewhere is reached by following links from them.
 */
export function selectedRecords<T>(selection: Selection<T>): Source<T> {
  return new Source({ origin: listedRecords, itemOf: (blob) => itemOf(selection, blob) });
}

/**
 * The blobs a store holds that read as objects of the schema of `selection`, records or not, each
 * as what `selection` reads it as.
 *
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A blob that is not an object, such as an attachment, is not one of these, as an object of
 *   another schema is not.
 * - Anyone can send a blob that names the schema and does not fit it, or that `selection` or the
 *   `rows` of an index throw on. A scan of an index that reads these, itself or through an index it
 *   reads, therefore gives the rows without those of such a blob, and lists it in their `failures`.
 * - A scan reads every blob the store holds, attachments as well, once for each index.
 */
export function selectedBlobs<T, S extends ValueMap>(selection: SelectionBySchema<T, S>): Source<T> {
  return new Source({ origin: heldBlobs, itemOf: (blob) => itemOf(selection, blob) });
}

/**
 * What an application keeps of what it reads from a store, as rows: objects of one schema, derived
 * from the records its user writes, from the blobs the store holds, or from the rows of another
 * index.
 *
 * - An index is the set of rows that those give, so going through all of them and adding each as it
 *   is written come to the same rows, whatever the order and however often one is added.
 * - A row is an object written to the schema of the index, with a link as any object has, so the
 *   same data given twice is one row.
 * - An index comes only from `indexOver` and `union`, so what it reads is said by its sources and
 *   not by its rows.
 * - An index says which rows there are and not in what order: `orderedBy` gives it an order, and
 *   `scan` reads it in one.
 * - As a source, an index gives its rows, each as the object it is, in whatever order it is read,
 *   and nothing else: an object of its schema that the store holds is not one of them.
 */
export class Index<F extends ValueMap> extends Source<EncodedObject<F>> {
  readonly #derivation: Derivation<F>;

  static {
    derivationOf = (index) => index.#derivation;
  }

  constructor(derivation: Derivation<F>) {
    super({ origin: derivation, itemOf: (blob) => blob.objectOf(derivation.schema) });
    this.#derivation = derivation;
  }

  /**
   * The index of what this index and `others` read, with the rows that each of them gives, written
   * to the schema of this index. Each reads what its own source lists and hands what it reads that
   * as to its own rows, so two that take one record each give the rows of what they read.
   */
  union(...others: readonly Index<F>[]): Index<F> {
    const parts = new Map<Origin, readonly Part<F>[]>();
    for (const index of [this, ...others])
      for (const [origin, originParts] of index.#derivation.parts)
        parts.set(origin, [...(parts.get(origin) ?? []), ...originParts]);
    return new Index(new Derivation(this.#derivation.schema, parts));
  }

  /**
   * This index with its rows in the order of their fields `by`, which `scan` gives ranges of.
   *
   * - The first field counts most. Rows that hold the same in all of them are in the order of their
   *   links.
   * - A field that a row leaves out comes before any value. Numbers are in their order, strings in
   *   the order of their code units, and any other value, such as a link, in the order of its bytes
   *   in the object format.
   * - The orders of one index share its rows, so a store that keeps them reads each record once
   *   however many orders it is scanned in.
   */
  orderedBy<const By extends FieldNames<F>>(...by: By): OrderedIndex<F, By> {
    return new OrderedIndex({ index: this, by });
  }
}

/** An index with its rows in the order of some of their fields, from `orderedBy`. */
export class OrderedIndex<F extends ValueMap, By extends FieldNames<F>> {
  readonly #order: Order<F, By>;

  static {
    orderOf = (index) => index.#order;
  }

  constructor(order: Order<F, By>) {
    this.#order = order;
  }
}

/**
 * The index of what `source` reads, with the rows that `rows` gives of each: the data of each row,
 * which the index writes to `schema`.
 *
 * - The rows depend on what is read and its closure, which `reader` gives by link, and on nothing
 *   else; what depends on what else is written, such as whether something replaced a record, is
 *   worked out from the rows when they are read.
 * - Over another index, `reader` gives the rows of that index and the schema they are written to
 *   by link, as it gives what the store holds.
 * - `reader` throws for a blob the store fails to give, and a scan of the index fails with that
 *   even where the source or `rows` catch it, such as to give no row of something that came from
 *   elsewhere and does not read as they expect.
 */
export function indexOver<F extends ValueMap, T>(
  source: Source<T>,
  schema: Schema<F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<F> {
  const reading = readingOf(source);
  const part: Part<F> = async function* (blob) {
    const item = await reading.itemOf(blob);
    if (item !== undefined) yield* rows(item, blob.reader);
  };
  return new Index(new Derivation(schema, new Map([[reading.origin, [part]]])));
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
