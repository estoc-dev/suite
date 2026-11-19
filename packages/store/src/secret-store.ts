import type { Bytes, EncodedObject, Link } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { copiedBatch, leavesFirst } from "./batch.ts";
import { KeptRows, type RowKeeper, type RowsByIndex, rowsByIndex } from "./scan.ts";
import { type Store, StoreOf } from "./store.ts";

export interface SecretBatch {
  readonly secrets: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * - Bytes that are also written to the store are the store's as well: a blob that the store beside
 *   holds is not kept here again.
 * - Whether what is kept here is encrypted is up to the backend.
 * - It only grows, as a store does, so a key that is no longer used is still kept.
 */
export class SecretStore implements RowKeeper {
  // A private field makes the type nominal, so neither a store nor a private store can be given in
  // its place.
  readonly #backend: Backend;
  readonly [rowsByIndex]: RowsByIndex;

  constructor(store: Store, backend: Backend) {
    this.#backend = StoreOf.backendBeside(store, backend);
    this[rowsByIndex] = new KeptRows(this, {
      secrets: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#backend, link);
  }

  async write({ secrets, blobs }: SecretBatch): Promise<void> {
    const batch = copiedBatch(secrets, blobs, "a secret");
    await this.#backend.put(await leavesFirst(batch.objects, batch.blobs, this.#backend), batch.objects);
  }

  secrets(): AsyncIterable<Link<EncodedObject>> {
    return this.#backend.listedLinks();
  }

  blobs(): AsyncIterable<Link<unknown>> {
    return this.#backend.blobs();
  }
}
