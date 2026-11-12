import type { Fields, Link, Reader } from "@estoc/object";
import { DerivedObjects, type Listed } from "./derived-objects.ts";
import { type Rows, SortedRows } from "./sorted-rows.ts";
import { type Derivation, derivationOf, type FieldNames, type OrderedIndex, orderOf } from "./source.ts";
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

/** The rows of each index for what one store lists. */
export interface RowsByIndex {
  /** The rows that the index of `derivation` gives, each once. */
  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>>;
  /** The rows of `index` in its order. */
  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>>;
}

/** The rows of each index for a store that lists nothing. */
const noRows: RowsByIndex = {
  derivedObjectsOf: async (derivation) => new DerivedObjects(derivation),
  sortedRowsOf: async (index) => new SortedRows(index),
};

/** The rows kept of an index, with how many records and blobs of a store they are of. */
interface KeptObjects<D, F extends Fields<D>> {
  readonly objects: DerivedObjects<D, F>;
  readonly recordCount: number;
  readonly blobCount: number;
}

/**
 * The rows that a store keeps of each index it is scanned for, with how many of its records and
 * blobs they are of, so that a scan reads only those listed since, and those rows in each order
 * they are scanned in.
 *
 * - The rows of a record, a blob or a row of another index depend on it and its closure alone, and
 *   a store only grows, so the rows of those read before still hold.
 * - The rows of an index are kept once, for its orders and for each index that reads it.
 * - The rows are kept for as long as the index is, and their order for as long as the ordered index
 *   is, so a program makes each once and keeps it.
 * - Scans of one index go one after another, each from where the last left off, and one that fails
 *   leaves the rows as they were.
 */
export class KeptRows implements RowsByIndex {
  readonly #reader: Reader;
  readonly #backend: Pick<Backend, "records" | "blobs">;
  readonly #objectsByDerivation = new WeakMap<object, Promise<unknown>>();
  readonly #sortedRowsByIndex = new WeakMap<object, Promise<unknown>>();

  /** Keeps rows of what `backend` lists, each read from `reader`. */
  constructor(reader: Reader, backend: Pick<Backend, "records" | "blobs">) {
    this.#reader = reader;
    this.#backend = backend;
  }

  sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    const derivedObjects = this.derivedObjectsOf(derivationOf(orderOf(index).index));
    // What is kept under an ordered index are rows of it.
    const kept = this.#sortedRowsByIndex.get(index) as Promise<SortedRows<D, F, By>> | undefined;
    const previous = kept ?? Promise.resolve(new SortedRows(index));
    const next = Promise.all([previous, derivedObjects]).then(([sortedRows, objects]) => sortedRows.including(objects));
    this.#sortedRowsByIndex.set(
      index,
      next.catch(() => previous),
    );
    return next;
  }

  derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    // What is kept under what an index is made of are rows of it.
    const kept = this.#objectsByDerivation.get(derivation) as Promise<KeptObjects<D, F>> | undefined;
    const previous = kept ?? Promise.resolve({ objects: new DerivedObjects(derivation), recordCount: 0, blobCount: 0 });
    const next = previous.then(async ({ objects, recordCount, blobCount }) => {
      const records: Link<unknown>[] = [];
      if (derivation.parts.has("records"))
        for await (const link of this.#backend.records(recordCount)) records.push(link);
      const blobs: Link<unknown>[] = [];
      // A store holds many more blobs than records, and most indexes read none of them.
      if (derivation.parts.has("blobs")) for await (const link of this.#backend.blobs(blobCount)) blobs.push(link);
      return {
        objects: await objects.adding({ records, blobs }, this.#reader, this),
        recordCount: recordCount + records.length,
        blobCount: blobCount + blobs.length,
      };
    });
    this.#objectsByDerivation.set(
      derivation,
      next.catch(() => previous),
    );
    return next.then(({ objects }) => objects);
  }
}

/**
 * The rows of each index for what a store lists and some records and blobs besides, as for a staged
 * batch: those that `rows` has for the store, then those of `added`, each read from `reader`.
 * Nothing is kept of them.
 */
export class AddedRows implements RowsByIndex {
  readonly #rows: RowsByIndex;
  readonly #added: Listed;
  readonly #reader: Reader;

  constructor(rows: RowsByIndex, added: Listed, reader: Reader) {
    this.#rows = rows;
    this.#added = added;
    this.#reader = reader;
  }

  async sortedRowsOf<D, F extends Fields<D>, By extends FieldNames<F>>(
    index: OrderedIndex<D, F, By>,
  ): Promise<SortedRows<D, F, By>> {
    // The rows in their order come first, so that those derived next go on from the ones they are of.
    const sortedRows = await this.#rows.sortedRowsOf(index);
    return sortedRows.including(await this.derivedObjectsOf(derivationOf(orderOf(index).index)));
  }

  async derivedObjectsOf<D, F extends Fields<D>>(derivation: Derivation<D, F>): Promise<DerivedObjects<D, F>> {
    return (await this.#rows.derivedObjectsOf(derivation)).adding(this.#added, this.#reader, this);
  }
}
