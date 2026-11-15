import type { Link, Reader, ValueMap } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import type { PrivateStore } from "./private-store.ts";
import { objectRecordedAt } from "./record.ts";
import type { SecretStore } from "./secret-store.ts";
import { type Rows, SortedRows } from "./sorted-rows.ts";
import {
  type Derivation,
  derivationOf,
  type FieldNames,
  type ItemFailure,
  type Listing,
  type OrderedIndex,
  orderOf,
} from "./source.ts";
import type { StagedStore, Store } from "./store.ts";

/**
 * Fills `index` from `store`: from all the blobs it holds when the index reads blobs, from all the
 * marks it lists and the objects they record when it is a private store, from all the secrets it
 * lists when it is a secret store, and from all the rows of each index it reads, filled from
 * `store` in the same way.
 *
 * - The blobs a store holds reach an index over blobs, and on a staged batch those that the batch
 *   keeps as well. On a secret store, only the blobs kept in it do: a blob that the store beside
 *   holds is not kept there.
 * - The marks of a private store reach an index over marks, each as the object it is. An index
 *   over marks reads nothing from anything else: an object of the schema of a mark that a store
 *   holds is not a mark.
 * - The objects that the records among the marks of a private store link to reach an index over
 *   records. A record itself does not: the index reads the object it links to. What came from
 *   elsewhere is reached by following links from them.
 * - On a private store, the blobs are those that the store beside it holds, in the order that
 *   store took them in. What only the private store keeps, its marks among them, reaches no index
 *   over blobs.
 * - The secrets of a secret store reach an index over secrets, each as the object it is, and
 *   nothing of anything else does.
 * - Only the rows of an index reach an index over it. They are kept beside the store and are not
 *   blobs of it: its `get` gives none of them, and an index over its blobs reads none.
 * - Each selection of the index reads each thing listed from the store, except that a selection by
 *   schema is handed the object read with its schema, and only an object of that schema. A row of
 *   another index is handed as the object it is.
 * - Within one thing listed, a blob, the thing itself among them, is read from the store once,
 *   however many selections and rows read it, and an object is read and validated with a schema
 *   once, however many selections by that schema read it.
 * - A store, a private store and a secret store keep the rows of each index they are scanned for,
 *   and those rows in each order they are scanned in, so a later scan reads only the marks and the
 *   secrets listed, the blobs put and the rows given since. A staged batch reads its own on top of
 *   the rows that its store keeps.
 * - What a source of the index or its `rows` throw on, or give a row of whose data does not fit the
 *   schema of the index, gives no rows of that source, and the rest is read still. It is listed in
 *   the `failures` of the rows, as is what each index that this one reads failed on, and is kept
 *   with the rows, so a later scan does not read it again.
 * - A scan of an index that reads only recorded objects, marks and secrets, itself and through the
 *   indexes it reads, throws when there are failures: what it reads is what its user wrote, so a
 *   failure is a mistake to be seen. A scan of one that reads blobs gives the rows with their
 *   failures, as anyone can send a blob that it fails on. `throwsOnFailure` says which a scan does,
 *   whatever the index reads.
 *
 * @throws the error of the first of the failures, when it throws on failure.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it. Nothing is kept of what such a scan read, and a later one reads it
 *   again.
 * @throws when the store gives no blob for a mark or a secret it lists.
 * @throws {TypeError} for a store or a staged batch not made by `new Store`.
 */
export async function scan<F extends ValueMap, By extends FieldNames<F>>(
  store: Store | StagedStore | PrivateStore | SecretStore,
  index: OrderedIndex<F, By>,
  { throwsOnFailure }: { readonly throwsOnFailure?: boolean } = {},
): Promise<Rows<F, By>> {
  if (!(rowsByIndex in store))
    throw new TypeError("only a store made by `new Store`, or what is kept beside or staged on one, is scanned");
  const { readsBlobs } = derivationOf(orderOf(index).index);
  const rows = await (store as RowKeeper)[rowsByIndex].sortedRowsOf(index);
  const [failure] = rows.failures;
  if (failure !== undefined && (throwsOnFailure ?? !readsBlobs)) throw failure.error;
  return rows;
}

/** The key under which `scan` asks a store for the rows it has of each index, which nothing outside this package can. */
export const rowsByIndex: unique symbol = Symbol("rowsByIndex");

/** A store that has the rows of the indexes it is scanned for. It is asked for them once for each scan. */
export interface RowKeeper {
  readonly [rowsByIndex]: RowsByIndex;
}

/** What one store lists, and the rows of each index for that. */
export interface RowsByIndex {
  recordedObjects(): Promise<ListedLinks>;
  marks(): Promise<ListedLinks>;
  secrets(): Promise<ListedLinks>;
  heldBlobs(): Promise<ListedLinks>;
  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
}

/** Links that a store lists, each once: of its marks, of the objects they record, of its secrets, or of its blobs. */
class ListedLinks implements Listing {
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[] = [];

  constructor(links: readonly Link<unknown>[] = []) {
    this.links = links;
  }

  /** These, then those of `links` that are not among them, each once. */
  async adding(links: Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>): Promise<ListedLinks> {
    const addedLinks: Link<unknown>[] = [];
    for await (const link of links) addedLinks.push(link);
    if (addedLinks.length === 0) return this;
    const listedLinks = new Set([...this.links, ...addedLinks]);
    return listedLinks.size === this.links.length ? this : new ListedLinks([...listedLinks]);
  }

  objectOf(): undefined {
    return undefined;
  }

  bytesOf(): undefined {
    return undefined;
  }
}

/**
 * The objects that the records among the marks of a private store link to, and how many marks were
 * read for them.
 */
class RecordedObjects {
  readonly objects: ListedLinks;
  /** How many marks were read, records or not: a later reading starts after them. */
  readonly readCount: number;

  constructor(objects = new ListedLinks(), readCount = 0) {
    this.objects = objects;
    this.readCount = readCount;
  }

  /**
   * These, then the objects that the records among `marks` link to, each read from `reader`. A mark
   * of another schema, as most are, records nothing.
   *
   * @throws when `reader` gives no blob for one of `marks`, or one that is not an object.
   */
  async adding(marks: AsyncIterable<Link<unknown>>, reader: Reader): Promise<RecordedObjects> {
    const objects: Link<unknown>[] = [];
    let readCount = this.readCount;
    for await (const mark of marks) {
      readCount += 1;
      const object = await objectRecordedAt(mark, reader);
      if (object !== undefined) objects.push(object);
    }
    return readCount === this.readCount ? this : new RecordedObjects(await this.objects.adding(objects), readCount);
  }
}

const noRecordedObjects = new RecordedObjects();

/**
 * What a store keeps from one scan to the next. Scans take it further one after another, each from
 * where the last left it, and one that fails leaves it as it was.
 */
class KeptValue<T> {
  #value: Promise<T>;

  constructor(initial: T) {
    this.#value = Promise.resolve(initial);
  }

  advance(step: (value: T) => Promise<T>): Promise<T> {
    const previous = this.#value;
    const next = previous.then(step);
    this.#value = next.catch(() => previous);
    return next;
  }
}

/**
 * The lists of a store, each from the link at `start` on.
 *
 * - A store lists its blobs.
 * - A private store lists its marks, and the blobs of the store beside it.
 * - A secret store lists its secrets, and the blobs kept in it.
 */
export interface StoreLists {
  marks?(start: number): AsyncIterable<Link<unknown>>;
  secrets?(start: number): AsyncIterable<Link<unknown>>;
  blobs(start: number): AsyncIterable<Link<unknown>>;
}

/**
 * What a store keeps of what it lists and of each index it is scanned for, so that a scan reads
 * only what was listed since: the links of its marks, of the objects they record, of its secrets
 * and of its blobs, the rows of each index, and those rows in each order they are scanned in.
 *
 * - The rows of a recorded object, a mark, a secret, a blob or a row of another index depend on it
 *   and its closure alone, and a store only grows, so the rows of those read before still hold.
 * - The links are kept once for all the indexes that read them, and those of the blobs only once
 *   an index reads blobs: a store holds many more blobs than a private store lists marks, and most
 *   indexes read none.
 * - The rows of an index are kept once, for its orders and for each index that reads it.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #lists: StoreLists;
  readonly #recordedObjects = new KeptValue(noRecordedObjects);
  readonly #marks = new KeptValue(new ListedLinks());
  readonly #secrets = new KeptValue(new ListedLinks());
  readonly #blobs = new KeptValue(new ListedLinks());
  readonly #objectsByDerivation = new WeakMap<object, KeptValue<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, KeptValue<unknown>>();

  /** Keeps rows of what `lists` give, each read from `reader`. */
  constructor(reader: Reader, lists: StoreLists) {
    this.#reader = reader;
    this.#lists = lists;
  }

  async recordedObjects(): Promise<ListedLinks> {
    const recorded = await this.#recordedObjects.advance(async (read) => {
      const marks = this.#lists.marks?.(read.readCount);
      return marks === undefined ? read : read.adding(marks, this.#reader);
    });
    return recorded.objects;
  }

  marks(): Promise<ListedLinks> {
    return this.#marks.advance((listed) => listed.adding(this.#lists.marks?.(listed.links.length) ?? []));
  }

  secrets(): Promise<ListedLinks> {
    return this.#secrets.advance((listed) => listed.adding(this.#lists.secrets?.(listed.links.length) ?? []));
  }

  heldBlobs(): Promise<ListedLinks> {
    return this.#blobs.advance((listed) => listed.adding(this.#lists.blobs(listed.links.length)));
  }

  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>> {
    // What is kept under what an index is made of are rows of it.
    let kept = this.#objectsByDerivation.get(derivation) as KeptValue<DerivedObjects<F>> | undefined;
    if (kept === undefined) {
      kept = new KeptValue(new DerivedObjects(derivation));
      this.#objectsByDerivation.set(derivation, kept);
    }
    return kept.advance((objects) => objects.adding(this.#reader, this));
  }

  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>> {
    // What is kept under an ordered index are rows of it.
    let kept = this.#sortedRowsByIndex.get(index) as KeptValue<SortedRows<F, By>> | undefined;
    if (kept === undefined) {
      kept = new KeptValue(new SortedRows(index));
      this.#sortedRowsByIndex.set(index, kept);
    }
    // The rows in their order come first, so that those derived next go on from the ones they are of.
    return kept.advance(async (sortedRows) =>
      sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index))),
    );
  }
}

/**
 * What a store lists and some blobs besides, as for a staged batch, and the rows of each index for
 * that.
 *
 * - It lists what `rows` has for the store, then the blobs of `addedBlobs` that the store does not
 *   hold, each once. A batch can hold what its store holds already, and the rows and their
 *   failures are those of the store once the batch is written.
 * - The rows of what it lists beyond the store are read from `reader`, on top of those that `rows`
 *   has.
 * - It is for one scan: the rows of an index are worked out once for the order and for each index
 *   that reads it, and nothing is kept of them for the next scan, which makes another of these.
 */
export class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #addedBlobs: readonly Link<unknown>[];
  readonly #reader: Reader;
  readonly #objectsByDerivation = new Map<object, Promise<unknown>>();

  constructor(rows: RowsByIndex, addedBlobs: readonly Link<unknown>[], reader: Reader) {
    this.#rows = rows;
    this.#addedBlobs = addedBlobs;
    this.#reader = reader;
  }

  recordedObjects(): Promise<ListedLinks> {
    return this.#rows.recordedObjects();
  }

  marks(): Promise<ListedLinks> {
    return this.#rows.marks();
  }

  secrets(): Promise<ListedLinks> {
    return this.#rows.secrets();
  }

  async heldBlobs(): Promise<ListedLinks> {
    return (await this.#rows.heldBlobs()).adding(this.#addedBlobs);
  }

  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>> {
    // What is worked out under what an index is made of are rows of it.
    let objects = this.#objectsByDerivation.get(derivation) as Promise<DerivedObjects<F>> | undefined;
    if (objects === undefined) {
      objects = this.#rows.derivedObjectsOf(derivation).then((kept) => kept.adding(this.#reader, this));
      this.#objectsByDerivation.set(derivation, objects);
    }
    return objects;
  }

  async sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(
    index: OrderedIndex<F, By>,
  ): Promise<SortedRows<F, By>> {
    // The rows in their order come first, so that those derived next go on from the ones they are of.
    const sortedRows = await this.#rows.sortedRowsOf(index);
    return sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index)));
  }
}
