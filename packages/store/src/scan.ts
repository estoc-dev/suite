import type { Fields, Link, Reader } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import { type Rows, SortedRows } from "./sorted-rows.ts";
import { type Derivation, derivationOf, type FieldNames, type Listing, type OrderedIndex, orderOf } from "./source.ts";
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
 *
 * @throws when the data of a record does not fit the schema of a selection by schema that reads it.
 * @throws where a selection over records throws, where the `rows` of an index throw over records or
 *   over another index, and when the data of a row they give does not fit the schema of the index.
 * @throws when the store throws, or gives no blob, for a link that a selection or its rows read,
 *   even where they catch it.
 * @throws when the index reads blobs, itself or through an index it reads, and `store` is something
 *   else with a `get` and `records`, which cannot list them.
 */
export async function scan<D, F extends Fields<D>, By extends FieldNames<F>>(
  store: Pick<Store, "get" | "records">,
  index: OrderedIndex<D, F, By>,
): Promise<Rows<D, F, By>> {
  if (rowsByIndex in store) return (store as RowKeeper)[rowsByIndex].sortedRowsOf(index);
  if (derivationOf(orderOf(index).index).readsBlobs)
    throw new Error("only a store, a private store or a staged batch lists the blobs an index over blobs reads");
  const records: Link<unknown>[] = [];
  for await (const link of store.records()) records.push(link);
  return new AddedRows(noRows, { records, blobs: [] }, store).sortedRowsOf(index);
}

/** The key under which `scan` asks a store for the rows it has of each index, which nothing outside this package can. */
export const rowsByIndex: unique symbol = Symbol("rowsByIndex");

/** A store that has the rows of the indexes it is scanned for. */
export interface RowKeeper {
  readonly [rowsByIndex]: RowsByIndex;
}

/** What one store lists, and the rows of each index for that. */
export interface RowsByIndex {
  /** The records that the store lists. */
  listedRecords(): Promise<ListedLinks>;
  /** The blobs that the store holds. */
  heldBlobs(): Promise<ListedLinks>;
  /** The rows that the index of `derivation` gives, each once. */
  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>>;
  /** The rows of `index` in its order. */
  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>>;
}

/** What a store lists of the blobs it holds: its records, or all of them. */
class ListedLinks implements Listing {
  readonly links: readonly Link<unknown>[];

  constructor(links: readonly Link<unknown>[] = []) {
    this.links = links;
  }

  /** These, then `links`. */
  async adding(links: Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>): Promise<ListedLinks> {
    const addedLinks: Link<unknown>[] = [];
    for await (const link of links) addedLinks.push(link);
    return addedLinks.length === 0 ? this : new ListedLinks([...this.links, ...addedLinks]);
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
class Kept<T> {
  #value: Promise<T>;

  constructor(initial: T) {
    this.#value = Promise.resolve(initial);
  }

  /** Keeps what `step` gives of what is kept. */
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
  readonly #records = new Kept(new ListedLinks());
  readonly #blobs = new Kept(new ListedLinks());
  readonly #objectsByDerivation = new WeakMap<object, Kept<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, Kept<unknown>>();

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

  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    // What is kept under what an index is made of are rows of it.
    let kept = this.#objectsByDerivation.get(derivation) as Kept<DerivedObjects<D, F>> | undefined;
    if (kept === undefined) {
      kept = new Kept(new DerivedObjects(derivation));
      this.#objectsByDerivation.set(derivation, kept);
    }
    return kept.advance((objects) => objects.adding(this.#reader, this));
  }

  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    // What is kept under an ordered index are rows of it.
    let kept = this.#sortedRowsByIndex.get(index) as Kept<SortedRows<D, F, By>> | undefined;
    if (kept === undefined) {
      kept = new Kept(new SortedRows(index));
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
 * each index for that: what `rows` has for the store, then `added` and the rows of it, each read
 * from `reader`. Nothing is kept of them.
 */
export class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #added: AddedLinks;
  readonly #reader: Reader;

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

  async derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    return (await this.#rows.derivedObjectsOf(derivation)).adding(this.#reader, this);
  }

  async sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    // The rows in their order come first, so that those derived next go on from the ones they are of.
    const sortedRows = await this.#rows.sortedRowsOf(index);
    return sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index)));
  }
}
