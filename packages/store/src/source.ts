import {
  type EncodedObject,
  type Link,
  type LinkValue,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
  type ValueMap,
} from "@estoc/object";
import {
  fieldOf,
  type IndexDefinition,
  indexDefinitionOf,
  memberOf,
  type PartDefinition,
  partAlong,
  rowReaderOf,
  type ValuePath,
} from "./definition.ts";
import { type RecordData, recordSchema } from "./record.ts";
import type { BlobSet } from "./scan.ts";
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
  listingIn(blobSet: BlobSet): Promise<Listing>;
}

export interface ItemFailure {
  readonly item: Link<unknown>;
  readonly error: unknown;
}

export interface Listing<T = unknown> {
  readonly links: readonly Link<T>[];
  readonly failures: readonly ItemFailure[];
  bytesOf(link: Link<unknown>): Uint8Array | undefined;
}

const blobOrigin: Origin = { listingIn: (blobSet) => blobSet.blobs() };

interface Reading<T> {
  readonly origin: Origin;
  itemOf(blob: ScannedBlob): Promise<T | undefined>;
}

export class Derivation<F extends ValueMap> implements Origin {
  readonly schema: Schema<F>;
  readonly parts: ReadonlyMap<Origin, readonly Part<F>[]>;
  readonly definition: IndexDefinition | undefined;

  constructor(schema: Schema<F>, parts: ReadonlyMap<Origin, readonly Part<F>[]>) {
    this.schema = schema;
    this.parts = parts;
    const definitions = [...parts.values()].flat().map(({ definition }) => definition);
    this.definition = definitions.every((definition) => definition !== undefined)
      ? indexDefinitionOf(schema, definitions)
      : undefined;
  }

  listingIn(blobSet: BlobSet): Promise<Listing> {
    return blobSet.rowsOf(this);
  }
}

// `indexOver` and the scan of a store read what a source and an index are made of, which nothing outside this
// package can.
let readingOf: <T>(source: Source<T>) => Reading<T>;
export let derivationOf: <F extends ValueMap>(index: Index<F>) => Derivation<F>;

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

export function selectedRecords<T>(selection: Selection<T>): Source<T> {
  return new Source({ origin: readingOf(recordedStatements).origin, itemOf: (blob) => itemOf(selection, blob) });
}

/**
 * - It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 *   can send a bundle with an object of any schema in it, so an unsigned object read this way may
 *   be a stranger's.
 * - A scan reads every blob it is over, attachments as well, once for each index.
 */
export function selectedBlobs<T, S extends ValueMap>(selection: SelectionBySchema<T, S>): Source<T> {
  return new Source({ origin: blobOrigin, itemOf: (blob) => itemOf(selection, blob) });
}

export interface HeldBlob {
  readonly link: Link<unknown>;
  readonly bytes: Uint8Array;
}

/**
 * Every blob that a scan is over, whatever its bytes are: an attachment and what a stranger sent as
 * well as an object of the store's own. A scan reads each of them once for each index.
 */
export const heldBlobs: Source<HeldBlob> = new Source({ origin: blobOrigin, itemOf: heldBlobOf });

async function heldBlobOf({ link, reader }: ScannedBlob): Promise<HeldBlob> {
  return { link, bytes: await reader.get(link) };
}

/**
 * An index is the set of rows that what it reads gives, so going through all of it and adding each
 * as it is written come to the same rows, whatever the order and however often one is added.
 */
export class Index<F extends ValueMap> extends Source<EncodedObject<F>> {
  readonly #derivation: Derivation<F>;
  readonly #linkedBlobsByField = new Map<string, Source<HeldBlob>>();

  static {
    derivationOf = (index) => index.#derivation;
  }

  constructor(derivation: Derivation<F>) {
    super({ origin: derivation, itemOf: (blob) => blob.objectOf(derivation.schema) });
    this.#derivation = derivation;
  }

  get rowSchema(): Schema<F> {
    return this.#derivation.schema;
  }

  /** An index has none where a function gives the rows of any of its parts. */
  get definition(): IndexDefinition | undefined {
    return this.#derivation.definition;
  }

  /**
   * - The blobs that the rows link to under `field`, each once however many rows link to it, and
   *   whatever its bytes are. Only the link is taken from a row: what reads these is given each
   *   blob as `heldBlobs` gives one, and what it fails on is the blob, and not the row.
   * - They are the store's own as far as the rows are: what a row that comes of a stranger's object
   *   links to is whatever the stranger named.
   * - A scan throws where neither the store nor what the rows are read from holds a blob linked to.
   *   A staged batch that holds the blob does not change that for a row the store already has: the
   *   rows of the store are worked out before those of the batch.
   */
  linksAt<N extends string>(this: Index<Readonly<Record<N, LinkValue<unknown>>>>, field: N): Source<HeldBlob> {
    // What reads the same links of the same rows reads one source, so that in a union each blob is
    // read once for all of them.
    const kept = this.#linkedBlobsByField.get(field);
    if (kept !== undefined) return kept;
    const derivation = this.#derivation;
    const { document } = derivation.schema;
    const rowField = fieldOf(document, field);
    if (rowField?.type !== "link" || rowField.optional === true)
      throw new Error(`a row of ${document.title} may hold no link under ${field}`);
    const linkedBlobs = new Source({
      origin: { listingIn: async (blobSet) => (await blobSet.rowsOf(derivation)).linksAt(field) },
      itemOf: heldBlobOf,
    });
    this.#linkedBlobsByField.set(field, linkedBlobs);
    return linkedBlobs;
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
 * It reads every blob that a scan is over: an attachment and what a stranger sent as well as an
 * object of the store's own, each once for each index that reads this way. `reading` gives the
 * index of the same definition over something else.
 */
export class IndexOfRows<F extends ValueMap> extends Index<F> {
  readonly #part: Required<Part<F>>;

  constructor(schema: Schema<F>, part: Required<Part<F>>) {
    super(new Derivation(schema, new Map([[blobOrigin, [part]]])));
    this.#part = part;
  }

  /**
   * It reads the blobs that `source` gives an item of: each path starts at one of those, and what
   * the index fails on is one of them. Its rows are the store's own as far as those blobs are.
   */
  reading(source: Source<unknown>): Index<F> {
    const reading = readingOf(source);
    const part = this.#part;
    const partOfItems: Part<F> = {
      definition: part.definition,
      async *rowsOf(blob) {
        if ((await reading.itemOf(blob)) !== undefined) yield* part.rowsOf(blob);
      },
    };
    return new Index(new Derivation(this.rowSchema, new Map([[reading.origin, [partOfItems]]])));
  }
}

/**
 * Each row holds under every field a value that the path of the field reaches, from one blob read
 * that the paths start at. The paths say all of it, so the index has a definition.
 */
export function indexOfRows<F extends ValueMap>(
  schema: Schema<F>,
  paths: { readonly [N in keyof F]-?: ValuePath<F[N]> },
): IndexOfRows<F> {
  const definition = partAlong(paths);
  const rowsFrom = rowReaderOf(schema, definition);
  return new IndexOfRows(schema, {
    definition,
    async *rowsOf(blob) {
      yield* (await rowsFrom(blob)) as F[];
    },
  });
}

/**
 * The Records among the blobs read. A row is encoded to the same bytes as the Record it comes of,
 * so the rows are those Records, and what reads the records of a store reads this index.
 */
export const heldRecords: Index<RecordData> = indexOfRows(recordSchema, {
  object: memberOf(recordSchema).field("object"),
});

/**
 * The statements the store recorded. One of the same schema that only came to the store, as in a
 * bundle, is not one of these.
 */
export const recordedStatements: Source<HeldBlob> = heldRecords.linksAt("object");

async function itemOf<T>(selection: Selection<T>, blob: ScannedBlob): Promise<T | undefined> {
  if (!(selection instanceof SelectionBySchema)) return selection.read(blob.link, blob.reader);
  const object = await blob.objectOf(selection.schema);
  return object === undefined ? undefined : selection.itemOf(object, blob.reader);
}
