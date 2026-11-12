import type { Link, Reader, ValueMap } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
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
import type { Backend, Store } from "./store.ts";

/**
 * Fills `index` from `store`, which may also be a `PrivateStore` or a `StagedStore`: from all its
 * records, from all the blobs it holds when the index reads blobs, and from all the rows of each
 * index it reads, filled from `store` in the same way.
 *
 * - Only records reach an index over records, and on a staged batch the batch's records as well:
 *   what came from elsewhere is reached by following links from them.
 * - The blobs a store holds reach an index over blobs, and on a staged batch those that the batch
 *   keeps as well. On a private store, only the blobs kept in it do, as its records are only those
 *   written to it: a blob that the store beside holds is not kept there.
 * - Only the rows of an index reach an index over it. They are kept beside the store and are not
 *   blobs of it: its `get` gives none of them, and an index over its blobs reads none.
 * - Each selection of the index reads each record from the store, except that a selection by schema
 *   is handed the record read with its schema, and only a record of that schema. A row of another
 *   index is handed as the object it is.
 * - Within one record, a blob, the record among them, is read from the store once, however many
 *   selections and rows read it, and the record is read and validated with a schema once,
 *   however many selections by that schema read it.
 * - A store and a private store keep the rows of each index they are scanned for, and those rows in
 *   each order they are scanned in, so a later scan reads only the records listed, the blobs put and
 *   the rows given since. A staged batch reads its own on top of the rows that its store keeps.
 * - What a source of the index or its `rows` throw on, or give a row of whose data does not fit the
 *   schema of the index, gives no rows of that source, and the rest is read still. It is listed in
 *   the `failures` of the rows, as is what each index that this one reads failed on, and is kept
 *   with the rows, so a later scan does not read it again.
 * - A scan of an index that reads only records, itself and through the indexes it reads, throws
 *   when there are failures: what it reads is what its user wrote, so a failure is a mistake to be
 *   seen. A scan of one that reads blobs gives the rows with their failures, as anyone can send a
 *   blob that it fails on. `throwsOnFailure` says which a scan does, whatever the index reads.
 *
 * @throws the error of the first of the failures, when it throws on failure.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it. Nothing is kept of what such a scan read, and a later one reads it
 *   again.
 * @throws when the index reads blobs, itself or through an index it reads, and `store` is something
 *   else with a `get` and `records`, which cannot list them.
 */
export async function scan<F extends ValueMap, By extends FieldNames<F>>(
  store: Pick<Store, "get" | "records">,
  index: OrderedIndex<F, By>,
  { throwsOnFailure }: { readonly throwsOnFailure?: boolean } = {},
): Promise<Rows<F, By>> {
  const { readsBlobs } = derivationOf(orderOf(index).index);
  const rows = await (await rowsByIndexOf(store, readsBlobs)).sortedRowsOf(index);
  const [failure] = rows.failures;
  if (failure !== undefined && (throwsOnFailure ?? !readsBlobs)) throw failure.error;
  return rows;
}

async function rowsByIndexOf(store: Pick<Store, "get" | "records">, listsBlobs: boolean): Promise<RowsByIndex> {
  if (rowsByIndex in store) return (store as RowKeeper)[rowsByIndex];
  if (listsBlobs)
    throw new Error("only a store, a private store or a staged batch lists the blobs an index over blobs reads");
  const records: Link<unknown>[] = [];
  for await (const link of store.records()) records.push(link);
  return new AddedRows(noRows, { records, blobs: [] }, store);
}

/** The key under which `scan` asks a store for the rows it has of each index, which nothing outside this package can. */
export const rowsByIndex: unique symbol = Symbol("rowsByIndex");

/** A store that has the rows of the indexes it is scanned for. It is asked for them once for each scan. */
export interface RowKeeper {
  readonly [rowsByIndex]: RowsByIndex;
}

/** What one store lists, and the rows of each index for that. */
export interface RowsByIndex {
  listedRecords(): Promise<ListedLinks>;
  heldBlobs(): Promise<ListedLinks>;
  derivedObjectsOf<F extends ValueMap>(derivation: Derivation<F>): Promise<DerivedObjects<F>>;
  sortedRowsOf<F extends ValueMap, By extends FieldNames<F>>(index: OrderedIndex<F, By>): Promise<SortedRows<F, By>>;
}

/** What a store lists of the blobs it holds, each once: its records, or all of them. */
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

/** What a store that lists nothing has. */
const noRows: RowsByIndex = {
  listedRecords: async () => new ListedLinks(),
  heldBlobs: async () => new ListedLinks(),
  derivedObjectsOf: async (derivation) => new DerivedObjects(derivation),
  sortedRowsOf: async (index) => new SortedRows(index),
};

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
 * What a store keeps of what it lists and of each index it is scanned for, so that a scan reads
 * only what was listed since: the links of its records and of its blobs, the rows of each index,
 * and those rows in each order they are scanned in.
 *
 * - The rows of a record, a blob or a row of another index depend on it and its closure alone, and
 *   a store only grows, so the rows of those read before still hold.
 * - The links are kept once for all the indexes that read them, and those of the blobs only once
 *   an index reads blobs: a store holds many more blobs than records, and most indexes read none.
 * - The rows of an index are kept once, for its orders and for each index that reads it.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #backend: Pick<Backend, "records" | "blobs">;
  readonly #records = new KeptValue(new ListedLinks());
  readonly #blobs = new KeptValue(new ListedLinks());
  readonly #objectsByDerivation = new WeakMap<object, KeptValue<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, KeptValue<unknown>>();

  /** Keeps rows of what `backend` lists, each read from `reader`. */
  constructor(reader: Reader, backend: Pick<Backend, "records" | "blobs">) {
    this.#reader = reader;
    this.#backend = backend;
  }

  listedRecords(): Promise<ListedLinks> {
    return this.#records.advance((listed) => listed.adding(this.#backend.records(listed.links.length)));
  }

  heldBlobs(): Promise<ListedLinks> {
    return this.#blobs.advance((listed) => listed.adding(this.#backend.blobs(listed.links.length)));
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

/** The records and blobs that a staged batch has besides what its store lists. */
interface AddedLinks {
  readonly records: readonly Link<unknown>[];
  readonly blobs: readonly Link<unknown>[];
}

/**
 * What a store lists and some records and blobs besides, as for a staged batch, and the rows of
 * each index for that.
 *
 * - It lists what `rows` has for the store, then those of `added` that the store does not list,
 *   each once. A batch can list a record twice, or hold what its store holds already, and the rows
 *   and their failures are those of the store once the batch is written.
 * - The rows of what it lists beyond the store are read from `reader`, on top of those that `rows`
 *   has.
 * - It is for one scan: the rows of an index are worked out once for the order and for each index
 *   that reads it, and nothing is kept of them for the next scan, which makes another of these.
 */
export class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #added: AddedLinks;
  readonly #reader: Reader;
  readonly #objectsByDerivation = new Map<object, Promise<unknown>>();

  constructor(rows: RowsByIndex, added: AddedLinks, reader: Reader) {
    this.#rows = rows;
    this.#added = added;
    this.#reader = reader;
  }

  async listedRecords(): Promise<ListedLinks> {
    return (await this.#rows.listedRecords()).adding(this.#added.records);
  }

  async heldBlobs(): Promise<ListedLinks> {
    return (await this.#rows.heldBlobs()).adding(this.#added.blobs);
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
