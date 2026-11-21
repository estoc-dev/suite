import type { Link, Reader, ValueMap } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import { objectRecordedAt } from "./record.ts";
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
 * - A store keeps the rows of each index it is scanned for, so a later scan reads only what was
 *   listed or put since.
 * - What a source of the index or its `rows` throw on gives no rows of that source, is listed in
 *   the `failures` of the rows, and is not read again.
 * - Where the index reads blobs, failures do not throw unless asked to: anyone can send a blob that
 *   it fails on, and that would otherwise stop the other rows from being read.
 * - When the store throws, or gives no blob, for a link that is read, the scan throws even where a
 *   selection or its rows catch it, and nothing is kept of what it read.
 */
export async function scan<F extends ValueMap, By extends FieldNames<F>>(
  store: Store | StagedStore,
  index: OrderedIndex<F, By>,
  { throwsOnFailure }: { readonly throwsOnFailure?: boolean } = {},
): Promise<Rows<F, By>> {
  if (!(rowsByIndex in store))
    throw new TypeError("only a store made by `new Store`, or what is staged on one, is scanned");
  const { readsBlobs } = derivationOf(orderOf(index).index);
  const rows = await (store as RowKeeper)[rowsByIndex].sortedRowsOf(index);
  const [failure] = rows.failures;
  if (failure !== undefined && (throwsOnFailure ?? !readsBlobs)) throw failure.error;
  return rows;
}

/** The key under which `scan` asks a store for the rows it has of each index, which nothing outside this package can. */
export const rowsByIndex: unique symbol = Symbol("rowsByIndex");

export interface RowKeeper {
  readonly [rowsByIndex]: RowsByIndex;
}

export interface RowsByIndex {
  recordedObjects(): Promise<ListedLinks>;
  marks(): Promise<ListedLinks>;
  heldBlobs(): Promise<ListedLinks>;
  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
}

class ListedLinks implements Listing {
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[] = [];
  readonly #links: ReadonlySet<Link<unknown>>;

  constructor(links: ReadonlySet<Link<unknown>> = new Set()) {
    this.#links = links;
    this.links = [...links];
  }

  async adding(links: Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>): Promise<ListedLinks> {
    const addedLinks: Link<unknown>[] = [];
    for await (const link of links) addedLinks.push(link);
    if (addedLinks.length === 0) return this;
    const listedLinks = new Set([...this.links, ...addedLinks]);
    return listedLinks.size === this.links.length ? this : new ListedLinks(listedLinks);
  }

  has(link: Link<unknown>): boolean {
    return this.#links.has(link);
  }

  objectOf(): undefined {
    return undefined;
  }

  bytesOf(): undefined {
    return undefined;
  }
}

class RecordedObjects {
  readonly objects: ListedLinks;
  readonly readCount: number;

  constructor(objects = new ListedLinks(), readCount = 0) {
    this.objects = objects;
    this.readCount = readCount;
  }

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

export interface StoreLists {
  marks(start: number): AsyncIterable<Link<unknown>>;
  blobs(start: number): AsyncIterable<Link<unknown>>;
}

/**
 * - The rows of what is read depend on it and its closure alone, and a store only grows, so the
 *   rows of what was read before still hold.
 * - The links of the blobs are kept only once an index reads blobs: a store holds many more blobs
 *   than it lists marks, and most indexes read none.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #lists: StoreLists;
  readonly #recordedObjects = new KeptValue(noRecordedObjects);
  readonly #marks = new KeptValue(new ListedLinks());
  readonly #blobs = new KeptValue(new ListedLinks());
  readonly #objectsByDerivation = new WeakMap<object, KeptValue<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, KeptValue<unknown>>();

  constructor(reader: Reader, lists: StoreLists) {
    this.#reader = reader;
    this.#lists = lists;
  }

  async recordedObjects(): Promise<ListedLinks> {
    const recorded = await this.#recordedObjects.advance((read) =>
      read.adding(this.#lists.marks(read.readCount), this.#reader),
    );
    return recorded.objects;
  }

  marks(): Promise<ListedLinks> {
    return this.#marks.advance((listed) => listed.adding(this.#lists.marks(listed.links.length)));
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
 * - A batch can hold what its store holds already, so the rows and their failures are those of the
 *   store once the batch is written.
 * - It is for one scan, and nothing is kept of its rows for the next.
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
