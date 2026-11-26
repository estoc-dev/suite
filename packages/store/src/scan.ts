import type { EncodedObject, Link, Reader, ValueMap } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import { SortedRows } from "./sorted-rows.ts";
import {
  type Derivation,
  derivationOf,
  type FieldNames,
  heldRecords,
  type ItemFailure,
  type Listing,
  type OrderedIndex,
  orderOf,
} from "./source.ts";

/** In the order their Records come among the blobs of `rows`. */
export async function recordedStatementsIn(rows: RowsByIndex): Promise<Link<EncodedObject>[]> {
  const records = await rows.derivedObjectsOf(derivationOf(heldRecords));
  return records.objects.map(({ data }) => data.object.link);
}

export interface RowsByIndex {
  readonly blobCount: number;
  heldBlobs(): Promise<ListedLinks>;
  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
}

class ListedLinks implements Listing {
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[] = [];

  constructor(links: readonly Link<unknown>[] = []) {
    this.links = links;
  }

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
 * - The rows of what is read depend on it and its closure alone, and a store only grows, so the
 *   rows of what was read before still hold.
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
  readonly #objectsByDerivation = new Map<object, Promise<unknown>>();

  constructor(rows: RowsByIndex, blobs: ListedLinks, reader: Reader) {
    this.#rows = rows;
    this.#blobs = blobs;
    this.#reader = reader;
  }

  get blobCount(): number {
    return this.#blobs.links.length;
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
