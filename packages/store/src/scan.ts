import type { EncodedObject, Link, Reader, ValueMap } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import { statementRecordedIn } from "./record.ts";
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
import { objectWrittenIn } from "./written-object.ts";

/**
 * - A store keeps the rows of each index it is scanned for, so a later scan reads only what was
 *   put since.
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
  records(): Promise<ListedLinks<EncodedObject>>;
  writtenObjects(): Promise<ListedLinks>;
  heldBlobs(): Promise<ListedLinks>;
  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
}

class ListedLinks<T = unknown> implements Listing {
  readonly links: readonly Link<T>[];
  readonly failures: readonly ItemFailure[] = [];

  constructor(links: readonly Link<T>[] = []) {
    this.links = links;
  }

  async adding(links: Iterable<Link<T>> | AsyncIterable<Link<T>>): Promise<ListedLinks<T>> {
    const addedLinks: Link<T>[] = [];
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

/** The links that a listing gives, each of its items read once, with how many of them were read. */
class LinksRead<T = unknown> {
  readonly links: ListedLinks<T>;
  readonly readCount: number;

  constructor(links = new ListedLinks<T>(), readCount = 0) {
    this.links = links;
    this.readCount = readCount;
  }

  async adding(
    items: Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>,
    linkIn: (item: Link<unknown>) => Promise<Link<T> | undefined>,
  ): Promise<LinksRead<T>> {
    const links: Link<T>[] = [];
    let readCount = this.readCount;
    for await (const item of items) {
      readCount += 1;
      const link = await linkIn(item);
      if (link !== undefined) links.push(link);
    }
    return readCount === this.readCount ? this : new LinksRead(await this.links.adding(links), readCount);
  }
}

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
 * - The rows of what is read depend on it and its closure alone, and a store only grows, so the
 *   rows of what was read before still hold.
 * - Records are among the blobs, so every blob put is read once to list the statements recorded.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #blobsFrom: (start: number) => AsyncIterable<Link<unknown>>;
  readonly #records = new KeptValue(new LinksRead<EncodedObject>());
  readonly #writtenObjects = new KeptValue(new LinksRead());
  readonly #blobs = new KeptValue(new ListedLinks());
  readonly #objectsByDerivation = new WeakMap<object, KeptValue<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, KeptValue<unknown>>();

  constructor(reader: Reader, blobsFrom: (start: number) => AsyncIterable<Link<unknown>>) {
    this.#reader = reader;
    this.#blobsFrom = blobsFrom;
  }

  async records(): Promise<ListedLinks<EncodedObject>> {
    const read = await this.#records.advance((records) =>
      records.adding(this.#blobsFrom(records.readCount), async (blob) => {
        const bytes = await this.#reader.get(blob);
        if (bytes === undefined) throw new Error(`the store lists ${blob} but does not hold it`);
        return statementRecordedIn(bytes);
      }),
    );
    return read.links;
  }

  async writtenObjects(): Promise<ListedLinks> {
    const { links: statements } = await this.records();
    const read = await this.#writtenObjects.advance((objects) =>
      objects.adding(statements.slice(objects.readCount), (statement) => objectWrittenIn(statement, this.#reader)),
    );
    return read.links;
  }

  heldBlobs(): Promise<ListedLinks> {
    return this.#blobs.advance((listed) => listed.adding(this.#blobsFrom(listed.links.length)));
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
 * - A store stages no Record, so the batch adds nothing to what is recorded.
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

  records(): Promise<ListedLinks<EncodedObject>> {
    return this.#rows.records();
  }

  writtenObjects(): Promise<ListedLinks> {
    return this.#rows.writtenObjects();
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
