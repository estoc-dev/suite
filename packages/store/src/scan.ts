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

export interface ScanOptions {
  readonly throwsOnFailure?: boolean;
}

export async function scannedRows<F extends ValueMap, By extends FieldNames<F>>(
  rows: RowsByIndex,
  index: OrderedIndex<F, By>,
  { throwsOnFailure }: ScanOptions = {},
): Promise<Rows<F, By>> {
  const sortedRows = await rows.sortedRowsOf(index);
  const [failure] = sortedRows.failures;
  if (failure !== undefined && (throwsOnFailure ?? !index.readsBlobs)) throw failure.error;
  return sortedRows;
}

export interface RowsByIndex {
  readonly blobCount: number;
  records(): Promise<ListedLinks<EncodedObject>>;
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

async function recordedStatementAt(reader: Reader, blob: Link<unknown>): Promise<Link<EncodedObject> | undefined> {
  const bytes = await reader.get(blob);
  if (bytes === undefined) throw new Error(`the store lists ${blob} but does not hold it`);
  return statementRecordedIn(bytes);
}

/**
 * - The rows of what is read depend on it and its closure alone, and a store only grows, so the
 *   rows of what was read before still hold.
 * - Records are among the blobs, so every blob put is read once to list the statements recorded.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 * - One reading goes at a time and lists the blobs once, so all that it gives comes of the blobs
 *   held at that listing. What an index reads therefore waits without end if it reads the rows of
 *   the same store.
 */
export class KeptRows {
  readonly #reader: Reader;
  readonly #blobsFrom: (start: number) => AsyncIterable<Link<unknown>>;
  #lastRead: Promise<void> = Promise.resolve();
  #blobs = new ListedLinks();
  #records = new LinksRead<EncodedObject>();
  readonly #objectsByDerivation = new WeakMap<object, unknown>();
  readonly #sortedRowsByOrder = new WeakMap<object, unknown>();

  constructor(reader: Reader, blobsFrom: (start: number) => AsyncIterable<Link<unknown>>) {
    this.#reader = reader;
    this.#blobsFrom = blobsFrom;
  }

  read<T>(use: (rows: RowsByIndex) => Promise<T>): Promise<T> {
    const reading = this.#lastRead.then(async () => {
      this.#blobs = await this.#blobs.adding(this.#blobsFrom(this.#blobs.links.length));
      return use(this.#rowsOf(this.#blobs));
    });
    // Only that the reading is done is kept, so what it gave goes when whoever asked for it lets go.
    this.#lastRead = reading.then(
      () => {},
      () => {},
    );
    return reading;
  }

  #rowsOf(blobs: ListedLinks): RowsByIndex {
    const rows: RowsByIndex = {
      blobCount: blobs.links.length,
      heldBlobs: async () => blobs,
      records: async () => {
        this.#records = await this.#records.adding(blobs.links.slice(this.#records.readCount), (blob) =>
          recordedStatementAt(this.#reader, blob),
        );
        return this.#records.links;
      },
      derivedObjectsOf: async <F extends ValueMap>(derivation: Derivation<F>) => {
        // What is kept under what an index is made of are rows of it.
        const kept = this.#objectsByDerivation.get(derivation) as DerivedObjects<F> | undefined;
        const objects = await (kept ?? new DerivedObjects(derivation)).adding(this.#reader, rows);
        this.#objectsByDerivation.set(derivation, objects);
        return objects;
      },
      sortedRowsOf: async <F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>) => {
        // What is kept under the order of an index are rows of it, and of each index named after it.
        const order = orderOf(index);
        const kept = this.#sortedRowsByOrder.get(order) as SortedRows<F, By> | undefined;
        const derivedObjects = await rows.derivedObjectsOf(derivationOf(order.index));
        const sortedRows = (kept ?? new SortedRows(index)).including(derivedObjects, rows.blobCount);
        this.#sortedRowsByOrder.set(order, sortedRows);
        return sortedRows;
      },
    };
    return rows;
  }
}

const emptyRows: RowsByIndex = {
  blobCount: 0,
  records: async () => new ListedLinks(),
  heldBlobs: async () => new ListedLinks(),
  derivedObjectsOf: async <F extends ValueMap>(derivation: Derivation<F>) => new DerivedObjects(derivation),
  sortedRowsOf: async <F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>) =>
    new SortedRows(index),
};

/**
 * - A batch can hold what its store holds already, so the rows and their failures are those of the
 *   store once the batch is written, and the blobs counted are the ones it would then hold.
 * - A store stages no Record, so the batch adds nothing to what is recorded.
 * - It is for one scan, and nothing is kept of its rows for the next.
 */
export async function rowsWithAdded(
  rows: RowsByIndex,
  addedBlobs: readonly Link<unknown>[],
  reader: Reader,
): Promise<RowsByIndex> {
  return new AddedRows(rows, await (await rows.heldBlobs()).adding(addedBlobs), reader);
}

/** `members` lists each of them once. */
export function rowsOfMembers(members: readonly Link<unknown>[], reader: Reader): RowsByIndex {
  return new AddedRows(emptyRows, new ListedLinks(members), reader);
}

/** `blobs` lists those of `rows` first, so the blobs after them are the ones added. */
class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #blobs: ListedLinks;
  readonly #reader: Reader;
  #records: Promise<ListedLinks<EncodedObject>> | undefined;
  readonly #objectsByDerivation = new Map<object, Promise<unknown>>();

  constructor(rows: RowsByIndex, blobs: ListedLinks, reader: Reader) {
    this.#rows = rows;
    this.#blobs = blobs;
    this.#reader = reader;
  }

  get blobCount(): number {
    return this.#blobs.links.length;
  }

  records(): Promise<ListedLinks<EncodedObject>> {
    this.#records ??= this.#recordsWithAdded();
    return this.#records;
  }

  async #recordsWithAdded(): Promise<ListedLinks<EncodedObject>> {
    const records = new LinksRead(await this.#rows.records());
    const addedBlobs = this.#blobs.links.slice(this.#rows.blobCount);
    return (await records.adding(addedBlobs, (blob) => recordedStatementAt(this.#reader, blob))).links;
  }

  async heldBlobs(): Promise<ListedLinks> {
    return this.#blobs;
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
    const sortedRows = await this.#rows.sortedRowsOf(index);
    return sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index)), this.blobCount);
  }
}
