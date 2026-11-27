import {
  type EncodedObject,
  encodeSchema,
  type Link,
  LinkValue,
  memberOf,
  type Reader,
  type Schema,
  type Selection,
  SelectionBySchema,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { link, schema } from "@estoc/schema";
import {
  anyMemberObject,
  fieldOf,
  type IndexDefinition,
  indexDefinitionOf,
  memberObjectOf,
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
  readonly origin: Origin;
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

/** What a part throws where it failed on a blob that the one it was given links to. */
export class LinkedBlobError extends Error {
  readonly failure: ItemFailure;

  constructor(failure: ItemFailure) {
    super(`a part failed on ${failure.item}`, { cause: failure.error });
    this.failure = failure;
  }
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
  /** In the order they were given in, which the definition keeps whatever each of them reads. */
  readonly parts: readonly Part<F>[];
  readonly partsByOrigin: ReadonlyMap<Origin, readonly Part<F>[]>;
  readonly definition: IndexDefinition | undefined;

  constructor(schema: Schema<F>, parts: readonly Part<F>[]) {
    this.schema = schema;
    this.parts = parts;
    const partsByOrigin = new Map<Origin, Part<F>[]>();
    for (const part of parts) partsByOrigin.set(part.origin, [...(partsByOrigin.get(part.origin) ?? []), part]);
    this.partsByOrigin = partsByOrigin;
    const definitions = parts.map(({ definition }) => definition);
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
let partOf: <F extends ValueMap>(index: IndexOfRows<F>) => Part<F>;

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
 * It is for objects that carry their authority in a signature, such as a signed identity. Anyone
 * can send a bundle with an object of any schema in it, so an unsigned object read this way may be
 * a stranger's.
 */
export function selectedBlobs<T, S extends ValueMap>(selection: SelectionBySchema<T, S>): Source<T> {
  return new Source({
    origin: readingOf(heldObjectsOf(selection.schema)).origin,
    itemOf: (blob) => itemOf(selection, blob),
  });
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

type ComparedValue = LinkValue<unknown> | string | number | boolean;

const comparedTypes: readonly string[] = ["link", "string", "integer", "boolean"];

const comparedTypeOf = (value: ComparedValue): string =>
  value instanceof LinkValue ? "link" : Number.isSafeInteger(value) ? "integer" : typeof value;

const isSameValue = (value: Value | undefined, compared: ComparedValue): boolean =>
  value instanceof LinkValue && compared instanceof LinkValue ? value.link === compared.link : value === compared;

function requireLinkAt({ document }: Schema, field: string): void {
  const rowField = fieldOf(document, field);
  if (rowField?.type !== "link" || rowField.optional === true)
    throw new Error(`a row of ${document.title} may hold no link under ${field}`);
}

type LinkedRow<N extends string> = Readonly<Record<N, LinkValue<unknown>>>;

// The field that the links are put under is told by its name, and a name is not always one key to the
// compiler: a field named `10`, or one of a schema made with names that are worked out. So the type
// says of no link in the rows what it leads to.
type WithLinksToAnything<F> = {
  readonly [K in keyof F]: F[K] extends LinkValue<unknown> ? LinkValue<unknown> : F[K];
};

function rowsOfEachLinked<N extends string>(
  index: Index<LinkedRow<N>>,
  field: N,
  linksOf: (linkedBlob: ScannedBlob) => Promise<Iterable<Link<unknown>>>,
): Index<ValueMap> {
  const { schema } = derivationOf(index);
  requireLinkAt(schema, field);
  const { origin, itemOf } = readingOf(index);
  const part: Part<ValueMap> = {
    origin,
    async *rowsOf(blob) {
      const row = await itemOf(blob);
      if (row === undefined) return;
      for (const link of await linksOf(blob.blobAt(row.data[field].link)))
        yield { ...row.data, [field]: new LinkValue(link) };
    },
  };
  // A schema says that a field holds a link, and not what the link leads to, so the rows given are
  // of the schema of the index read.
  return new Index<ValueMap>(new Derivation(schema, [part]));
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

  /**
   * It says the paths that give the rows, so an index has one only where paths give the rows of
   * each of its parts. What the rows of this index are filtered, expanded or joined into has none.
   */
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
  linksAt<N extends string>(this: Index<LinkedRow<N>>, field: N): Source<HeldBlob> {
    // What reads the same links of the same rows reads one source, so that in a union each blob is
    // read once for all of them.
    const kept = this.#linkedBlobsByField.get(field);
    if (kept !== undefined) return kept;
    const derivation = this.#derivation;
    requireLinkAt(derivation.schema, field);
    const linkedBlobs = new Source({
      origin: { listingIn: async (blobSet) => (await blobSet.rowsOf(derivation)).linksAt(field) },
      itemOf: heldBlobOf,
    });
    this.#linkedBlobsByField.set(field, linkedBlobs);
    return linkedBlobs;
  }

  /**
   * The rows of this index that hold `value` under `field`, each with the link it has here. What
   * this index failed on is among the failures of the one given.
   */
  rowsWhere<N extends keyof F & string>(field: N, value: Extract<F[N], ComparedValue>): Index<F> {
    const { schema } = this.#derivation;
    const { title } = schema.document;
    const rowField = fieldOf(schema.document, field);
    if (rowField === undefined) throw new Error(`a row of ${title} has no field ${field}`);
    if (!comparedTypes.includes(rowField.type))
      throw new Error(
        `a row of ${title} holds ${rowField.type} under ${field}, and what is compared is a link, a string, an integer or a boolean`,
      );
    if (comparedTypeOf(value) !== rowField.type)
      throw new Error(`a row of ${title} holds ${rowField.type} under ${field}, and the value given is not one`);
    const { origin, itemOf } = readingOf(this);
    const part: Part<F> = {
      origin,
      async *rowsOf(blob) {
        const row = await itemOf(blob);
        if (row !== undefined && isSameValue(memberOf(row.data, field), value)) yield row.data;
      },
    };
    return new Index(new Derivation(schema, [part]));
  }

  /**
   * - A row of each link written in the blob that a row of this index links to under `field`: it
   *   holds that link under `field`, and what the row holds under every other field. So a row that
   *   links to a blob that is not an object gives none, and rows that hold the same under every
   *   field are one row.
   * - The link of the schema that the object is written to is among them, unless the object is
   *   written to itself.
   * - What this index failed on is among the failures of the one given.
   * - A scan throws where neither the store nor what the rows are read from holds a blob linked to.
   */
  rowsOfEachLinkFrom<N extends string>(this: Index<LinkedRow<N>>, field: N): Index<WithLinksToAnything<F>> {
    return rowsOfEachLinked(this, field, (linkedBlob) => linkedBlob.links()) as Index<WithLinksToAnything<F>>;
  }

  /**
   * - A row of each blob in the closure of the blob that a row of this index links to under `field`,
   *   that blob among them and whatever the bytes of each are: it holds the link of that blob under
   *   `field`, and what the row holds under every other field.
   * - What this index failed on is among the failures of the one given.
   * - A scan throws where neither the store nor what the rows are read from holds a blob of the
   *   closure.
   */
  rowsOfEachInClosureAt<N extends string>(this: Index<LinkedRow<N>>, field: N): Index<WithLinksToAnything<F>> {
    return rowsOfEachLinked(this, field, (linkedBlob) => linkedBlob.closureLinks()) as Index<WithLinksToAnything<F>>;
  }

  /**
   * - A row of each row that `linked` gives of the blob that a row of this index links to under
   *   `field`: it holds what both hold. So a row gives none where `linked` gives none of that blob.
   * - `linked` is an index that `reading` has not told what to read: here its paths take values
   *   of that blob.
   * - The rows are of a schema with the fields of both and an empty title. A field that both have
   *   is refused.
   * - Where `linked` fails on the blob, the index given fails on that blob, once for each row that
   *   links to it. What this index failed on is among its failures as well.
   * - A scan throws where neither the store nor what the rows are read from holds a blob that
   *   `linked` reads.
   */
  rowsJoinedAt<N extends string, G extends ValueMap>(
    this: Index<LinkedRow<N>>,
    field: N,
    linked: IndexOfRows<G>,
  ): Index<F & G> {
    const { document } = this.#derivation.schema;
    requireLinkAt(this.#derivation.schema, field);
    const linkedFields = linked.rowSchema.document.fields;
    const sharedName = Object.keys(linkedFields).find((name) => fieldOf(document, name) !== undefined);
    if (sharedName !== undefined) throw new Error(`the rows joined both have a field ${sharedName}`);
    const { origin, itemOf } = readingOf(this);
    const linkedPart = partOf(linked);
    const part: Part<ValueMap> = {
      origin,
      async *rowsOf(blob) {
        const row = await itemOf(blob);
        if (row === undefined) return;
        const linkedBlob = blob.blobAt(row.data[field].link);
        const linkedRows: ValueMap[] = [];
        try {
          for await (const linkedRow of linkedPart.rowsOf(linkedBlob)) linkedRows.push(linkedRow);
        } catch (error) {
          throw new LinkedBlobError({ item: linkedBlob.link, error });
        }
        for (const linkedRow of linkedRows) yield { ...row.data, ...linkedRow };
      },
    };
    const schema = encodeSchema({ title: "", fields: { ...document.fields, ...linkedFields } });
    return new Index<ValueMap>(new Derivation(schema, [part])) as Index<F & G>;
  }

  union(...others: readonly Index<F>[]): Index<F> {
    // The compiler takes two schemas whose fields fit each other as one, and the rows of every part
    // are encoded to the schema of this index.
    if (others.some((other) => other.#derivation.schema.link !== this.#derivation.schema.link))
      throw new Error("the indexes in a union hold rows of one schema, and one of these holds rows of another");
    const parts = [this, ...others].flatMap((index) => index.#derivation.parts);
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
    origin: reading.origin,
    async *rowsOf(blob) {
      const item = await reading.itemOf(blob);
      if (item !== undefined) yield* rows(item, blob.reader);
    },
  };
  return new Index(new Derivation(schema, [part]));
}

/**
 * It reads every blob that a scan is over: an attachment and what a stranger sent as well as an
 * object of the store's own, each once for each index that reads this way. `reading` gives the
 * index of the same definition over something else.
 */
export class IndexOfRows<F extends ValueMap> extends Index<F> {
  readonly #part: Required<Part<F>>;

  static {
    partOf = (index) => index.#part;
  }

  constructor(schema: Schema<F>, part: Required<Part<F>>) {
    super(new Derivation(schema, [part]));
    this.#part = part;
  }

  /**
   * - The paths take values of each blob that `source` gives an item of. Where a blob does not fit
   *   the schema that a path takes it as, the index fails on that blob, and not on the row that
   *   links to it.
   * - Where `source` fails on a blob before it gives an item, the index fails on that blob too. The
   *   failures of an index that `source` takes links of stay failures of this one, each on the item
   *   it was on.
   * - Its rows are the store's own as far as those blobs are.
   */
  reading(source: Source<unknown>): Index<F> {
    const reading = readingOf(source);
    const part = this.#part;
    const partOfItems: Part<F> = {
      origin: reading.origin,
      definition: part.definition,
      async *rowsOf(blob) {
        if ((await reading.itemOf(blob)) !== undefined) yield* part.rowsOf(blob);
      },
    };
    return new Index(new Derivation(this.rowSchema, [partOfItems]));
  }
}

/**
 * A row of each object read that every path takes a value of: it holds under each field what the
 * path of the field takes. The paths say all of it, so the index has a definition.
 */
export function indexOfRows<F extends ValueMap>(
  schema: Schema<F>,
  paths: { readonly [N in keyof F]-?: ValuePath<F[N]> },
): IndexOfRows<F> {
  const definition = partAlong(paths);
  const rowOf = rowReaderOf(schema, definition);
  return new IndexOfRows(schema, {
    origin: blobOrigin,
    definition,
    async *rowsOf(blob) {
      const row = await rowOf(blob);
      if (row !== undefined) yield row as F;
    },
  });
}

export const heldObjectSchema = schema("Held Object", { schema: link<Schema>(), object: link() });

/** An object written to itself has its own link as that of its schema. */
export const heldObjects = indexOfRows(heldObjectSchema, {
  schema: anyMemberObject.schema,
  object: anyMemberObject.link,
});

const heldObjectsBySchema = new Map<Link<Schema>, Source<HeldBlob>>();

/**
 * - The objects that name `schema` among the blobs read, whether they fit it or not, and wherever
 *   they came from: anyone can send a bundle with an object of any schema in it.
 * - Each is the blob that a row of `heldObjects` whose schema is this one links to under `object`,
 *   so what reads them is given no blob of another schema, and no attachment.
 */
export function heldObjectsOf(schema: Schema): Source<HeldBlob> {
  // What reads the objects of one schema reads one source: in a union each of them is read once, and
  // which they are is worked out once for all that read them.
  const kept = heldObjectsBySchema.get(schema.link);
  if (kept !== undefined) return kept;
  const objects = heldObjects.rowsWhere("schema", new LinkValue(schema.link)).linksAt("object");
  heldObjectsBySchema.set(schema.link, objects);
  return objects;
}

/**
 * The Records among the blobs read. A row is encoded to the same bytes as the Record it comes of,
 * so the rows are those Records, and what reads the records of a store reads this index.
 */
export const heldRecords: Index<RecordData> = indexOfRows(recordSchema, {
  object: memberObjectOf(recordSchema).field("object"),
}).reading(heldObjectsOf(recordSchema));

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
