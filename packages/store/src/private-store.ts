import type { Bytes, EncodedObject, Link } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { copiedBatch, leavesFirst } from "./batch.ts";
import { KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { type Store, StoreOf } from "./store.ts";

export interface MarkBatch {
  readonly marks: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * - A mark is kept here whether or not the store beside holds the same bytes, which anyone can send
 *   it, so what the store beside comes to hold changes neither what is listed here nor where it is
 *   kept.
 * - An object of the schema of a mark that came to the store beside, as in a bundle, is not a mark.
 * - Marks are not signed. That one is the user's own rests on what is handed the private store,
 *   which can write any mark, so it is no boundary between the programs that share it.
 */
export class PrivateStore implements RowKeeper {
  // Private fields make the type nominal, so neither a store nor a secret store can be given in
  // its place.
  readonly #backend: Backend;
  readonly #heldBlobs: Pick<Backend, "get" | "has">;
  readonly [rowsByIndex]: RowsByIndex;

  constructor(store: Store, backend: Backend) {
    this.#backend = backend;
    this.#heldBlobs = StoreOf.backendBeside(store, backend);
    this[rowsByIndex] = new KeptRows(this, {
      marks: (start) => backend.listedLinks(start),
      blobs: (start) => StoreOf.blobsOf(store, start),
    });
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#heldBlobs, link);
  }

  async write({ marks, blobs }: MarkBatch): Promise<void> {
    const batch = copiedBatch(marks, blobs, "a mark");
    await this.#backend.put(await leavesFirst(batch.objects, batch.blobs, this.#heldBlobs), batch.objects);
  }

  marks(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
  }
}
