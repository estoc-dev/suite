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

/** In the order their Records come among the blobs of `blobSet`. */
export async function recordedStatementsIn(blobSet: BlobSet): Promise<Link<EncodedObject>[]> {
  const records = await blobSet.rowsOf(derivationOf(heldRecords));
  return records.objects.map(({ data }) => data.object.link);
}

export interface BlobSet {
  readonly blobCount: number;
  blobs(): Promise<Listing>;
  /**
   * In the order they were first derived: an index that reads them reads only the ones after those
   * it read before.
   */
  rowsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  scan<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
  /**
   * - `blobs` can list what the set has already, and `reader` gives each of them with its closure.
   * - The rows of the set it gives are not kept with those of this one.
   */
  adding(blobs: readonly Link<unknown>[], reader: Reader): Promise<BlobSet>;
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

  read<T>(use: (blobSet: BlobSet) => Promise<T>): Promise<T> {
    const reading = this.#lastRead.then(async () => {
      this.#blobs = await this.#blobs.adding(this.#blobsFrom(this.#blobs.links.length));
      return use(this.#blobSetOf(this.#blobs));
    });
    // Only that the reading is done is kept, so what it gave goes when whoever asked for it lets go.
    this.#lastRead = reading.then(
      () => {},
      () => {},
    );
    return reading;
  }

  #blobSetOf(blobs: ListedLinks): BlobSet {
    const blobSet: BlobSet = {
      blobCount: blobs.links.length,
      blobs: async () => blobs,
      rowsOf: async <F extends ValueMap>(derivation: Derivation<F>) => {
        // What is kept under what an index is made of are rows of it.
        const kept = this.#objectsByDerivation.get(derivation) as DerivedObjects<F> | undefined;
        const objects = await (kept ?? new DerivedObjects(derivation)).adding(this.#reader, blobSet);
        this.#objectsByDerivation.set(derivation, objects);
        return objects;
      },
      scan: async <F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>) => {
        // What is kept under the order of an index are rows of it, and of each index named after it.
        const order = orderOf(index);
        const kept = this.#sortedRowsByOrder.get(order) as SortedRows<F, By> | undefined;
        const derivedObjects = await blobSet.rowsOf(derivationOf(order.index));
        const sortedRows = (kept ?? new SortedRows(index)).including(derivedObjects, blobSet.blobCount);
        this.#sortedRowsByOrder.set(order, sortedRows);
        return sortedRows;
      },
      adding: async (addedBlobs, reader) => new ListedBlobSet(await blobs.adding(addedBlobs), reader, blobSet),
    };
    return blobSet;
  }
}

/** `members` lists each of them once. */
export function blobSetOf(members: readonly Link<unknown>[], reader: Reader): BlobSet {
  return new ListedBlobSet(new ListedLinks(members), reader);
}

/** `blobs` lists those of `base` first, so the blobs after them are the ones added. */
class ListedBlobSet implements BlobSet {
  readonly blobCount: number;
  readonly #blobs: ListedLinks;
  readonly #reader: Reader;
  readonly #base: BlobSet | undefined;
  readonly #objectsByDerivation = new Map<object, Promise<unknown>>();

  constructor(blobs: ListedLinks, reader: Reader, base?: BlobSet) {
    this.blobCount = blobs.links.length;
    this.#blobs = blobs;
    this.#reader = reader;
    this.#base = base;
  }

  async blobs(): Promise<ListedLinks> {
    return this.#blobs;
  }

  rowsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>> {
    // What is worked out under what an index is made of are rows of it.
    let objects = this.#objectsByDerivation.get(derivation) as Promise<DerivedObjects<F>> | undefined;
    if (objects === undefined) {
      const baseObjects = this.#base?.rowsOf(derivation) ?? Promise.resolve(new DerivedObjects(derivation));
      objects = baseObjects.then((kept) => kept.adding(this.#reader, this));
      this.#objectsByDerivation.set(derivation, objects);
    }
    return objects;
  }

  async scan<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>> {
    const baseRows = (await this.#base?.scan(index)) ?? new SortedRows(index);
    return baseRows.including(await this.rowsOf(derivationOf(orderOf(index).index)), this.blobCount);
  }

  async adding(blobs: readonly Link<unknown>[], reader: Reader): Promise<BlobSet> {
    return new ListedBlobSet(await this.#blobs.adding(blobs), reader, this);
  }
}
