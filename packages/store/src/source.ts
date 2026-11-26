import {
  type EncodedObject,
  type Link,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
  type ValueMap,
} from "@estoc/object";
import {
  type IndexDefinition,
  indexDefinitionOf,
  type PartDefinition,
  partAlong,
  rowReaderOf,
  type ValuePath,
} from "./definition.ts";
import { recordOf, recordSchema } from "./record.ts";
import type { RowsByIndex } from "./scan.ts";
import type { ScannedBlob } from "./scanned-blob.ts";

export type FieldNames<F> = readonly (keyof F & string)[];

export type KeyOf<F, By extends FieldNames<F>> = {
  readonly [At in keyof By]: By[At] extends keyof F ? F[By[At]] : never;
};

/**
 * The empty prefix stands outside the condition, so that it fits even a `K` that is still a type
 * parameter.
 */
export type Prefix<K extends readonly unknown[]> =
  | readonly []
  | (K extends readonly [infer First, ...infer Rest] ? readonly [First, ...Prefix<Rest>] : K);

interface Part<F> {
  /** Left out where a function gives the rows. */
  readonly definition?: PartDefinition;
  rowsOf(blob: ScannedBlob): AsyncIterable<F>;
}

export interface Origin {
  readonly readsBlobs: boolean;
  listingIn(rows: RowsByIndex): Promise<Listing>;
}

export interface ItemFailure {
  readonly item: Link<unknown>;
  readonly error: unknown;
}

export interface Listing {
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[];
  objectOf(link: Link<unknown>): { readonly schema: object } | undefined;
  bytesOf(link: Link<unknown>): Uint8Array | undefined;
}

const recordedStatements: Origin = {
  readsBlobs: false,
  listingIn: (rows) => rows.records(),
};

const blobOrigin: Origin = {
  readsBlobs: true,
  listingIn: (rows) => rows.heldBlobs(),
};

interface Reading<T> {
  readonly origin: Origin;
  itemOf(blob: ScannedBlob): Promise<T | undefined>;
}

export class Derivation<F extends ValueMap> implements Origin {
  readonly schema: Schema<F>;
  readonly parts: ReadonlyMap<Origin, readonly Part<F>[]>;
  readonly readsBlobs: boolean;
  readonly partDefinitions: readonly PartDefinition[] | undefined;

  constructor(schema: Schema<F>, parts: ReadonlyMap<Origin, readonly Part<F>[]>) {
    this.schema = schema;
    this.parts = parts;
    this.readsBlobs = [...parts.keys()].some((origin) => origin.readsBlobs);
    const definitions = [...parts.values()].flat().map(({ definition }) => definition);
    this.partDefinitions = definitions.every((definition) => definition !== undefined) ? definitions : undefined;
  }

  listingIn(rows: RowsByIndex): Promise<Listing> {
    return rows.derivedObjectsOf(this);
  }
}

interface Order<F extends ValueMap, By extends FieldNames<F>> {
  readonly index: Index<F>;
  readonly by: By;
}

// `indexOver` and the scan of a store read what a source, an index and an ordered index are made of, which nothing
// outside this package can.
let readingOf: <T>(source: Source<T>) => Reading<T>;
export let derivationOf: <F extends ValueMap>(index: Index<F>) => Derivation<F>;
export let orderOf: <F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>) => Order<F, By>;

/**
 * A reading that trusts what an index derived holds only over the rows of that index, so it is
 * given as a source of those rows, and not as a selection that fits any listing.
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
 * The statements the store recorded. One of the same schema that only came to the store, as in a
 * bundle, is not one of these.
 */
export function selectedRecords<T>(selection: Selection<T>): Source<T> {
  return new Source({ origin: recordedStatements, itemOf: (blob) => itemOf(selection, blob) });
}

/**
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A scan reads every blob the store holds, attachments as well, once for each index.
 */
export function selectedBlobs<T, S extends ValueMap>(selection: SelectionBySchema<T, S>): Source<T> {
  return new Source({ origin: blobOrigin, itemOf: (blob) => itemOf(selection, blob) });
}

export interface HeldBlob {
  readonly link: Link<unknown>;
  readonly bytes: Uint8Array;
}

/**
 * Every blob the store holds, whatever its bytes are: an attachment and what a stranger sent as
 * well as an object of the store's own. A scan reads each of them once for each index.
 */
export const heldBlobs: Source<HeldBlob> = new Source({
  origin: blobOrigin,
  itemOf: async ({ link, reader }) => ({ link, bytes: await reader.get(link) }),
});

/**
 * An index is the set of rows that what it reads gives, so going through all of it and adding each
 * as it is written come to the same rows, whatever the order and however often one is added.
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

  union(...others: readonly Index<F>[]): Index<F> {
    // The compiler takes two schemas whose fields fit each other as one, and the rows of every part
    // are encoded to the schema of this index.
    if (others.some((other) => other.#derivation.schema.link !== this.#derivation.schema.link))
      throw new Error("the indexes in a union hold rows of one schema, and one of these holds rows of another");
    const parts = new Map<Origin, readonly Part<F>[]>();
    for (const index of [this, ...others])
      for (const [origin, originParts] of index.#derivation.parts)
        parts.set(origin, [...(parts.get(origin) ?? []), ...originParts]);
    return new Index(new Derivation(this.#derivation.schema, parts));
  }

  orderedBy<const By extends FieldNames<F>>(...by: By): OrderedIndex<F, By> {
    return new OrderedIndex({ index: this, by });
  }
}

export class OrderedIndex<F extends ValueMap, By extends FieldNames<F>> {
  readonly #order: Order<F, By>;

  static {
    orderOf = (index) => index.#order;
  }

  constructor(order: Order<F, By>) {
    this.#order = order;
  }

  get rowSchema(): Schema<F> {
    return derivationOf(this.#order.index).schema;
  }

  get order(): Readonly<By> {
    return this.#order.by;
  }

  /**
   * Whether any of what the index is made of reads every blob held, so that a row may come of an
   * object that a stranger sent. Where none does, every row comes of a statement the store recorded.
   */
  get readsBlobs(): boolean {
    return derivationOf(this.#order.index).readsBlobs;
  }

  /** A store keeps one set of rows for this index and each one named after it. */
  named(name: string): NamedIndex<F, By> {
    return new NamedIndex(this.#order, name);
  }
}

export class NamedIndex<F extends ValueMap, By extends FieldNames<F>> extends OrderedIndex<F, By> {
  readonly name: string;
  /** An index has none where a function gives the rows of any of its parts. */
  readonly definition: IndexDefinition | undefined;

  constructor(order: Order<F, By>, name: string) {
    super(order);
    this.name = name;
    const { schema, partDefinitions } = derivationOf(order.index);
    this.definition = partDefinitions && indexDefinitionOf(name, schema, order.by, partDefinitions);
  }
}

/**
 * - The rows depend on what is read and its closure, which `reader` gives by link, and on nothing
 *   else; what depends on what else is written, such as whether something replaced an object, is
 *   worked out from the rows when they are read.
 * - `reader` throws for a blob the store fails to give, and a scan of the index fails with that
 *   even where the source or `rows` catch it.
 */
export function indexOver<F extends ValueMap, T>(
  source: Source<T>,
  schema: Schema<F>,
  rows: (item: T, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<F> {
  const reading = readingOf(source);
  const part: Part<F> = {
    async *rowsOf(blob) {
      const item = await reading.itemOf(blob);
      if (item !== undefined) yield* rows(item, blob.reader);
    },
  };
  return new Index(new Derivation(schema, new Map([[reading.origin, [part]]])));
}

/**
 * Each row holds under every field the value that the path of the field reaches, from one object
 * that the paths start at. The paths say all of it, so the index has a definition where it is named.
 */
export function indexOfRows<F extends ValueMap>(
  schema: Schema<F>,
  paths: { readonly [N in keyof F]-?: ValuePath<F[N]> },
): Index<F> {
  const definition = partAlong(paths);
  const rowFrom = rowReaderOf(schema, definition);
  const readsRecords = definition.schema.link === recordSchema.link;
  const part: Part<F> = {
    definition,
    async *rowsOf(blob) {
      // A Record is the same bytes wherever it is encoded, so the one of a statement listed as
      // recorded is encoded here, and not looked for among the blobs.
      const start = readsRecords ? recordOf(blob.link as Link<EncodedObject>) : await blob.objectOf(definition.schema);
      const row = start && (await rowFrom(start, blob.reader));
      if (row !== undefined) yield row as F;
    },
  };
  return new Index(new Derivation(schema, new Map([[readsRecords ? recordedStatements : blobOrigin, [part]]])));
}

async function itemOf<T>(selection: Selection<T>, blob: ScannedBlob): Promise<T | undefined> {
  if (!(selection instanceof SelectionBySchema)) return selection.read(blob.link, blob.reader);
  const object = await blob.objectOf(selection.schema);
  return object === undefined ? undefined : selection.itemOf(object, blob.reader);
}
