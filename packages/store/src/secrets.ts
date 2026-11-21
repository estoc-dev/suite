import type { Bytes, Link } from "@estoc/object";
import { type Backend, blobIn } from "./backend.ts";
import { type Batch, copiedBlobs, leavesFirst } from "./batch.ts";

/**
 * - It is given the backend of a store, reads every blob there, Secrets as well, and is the one
 *   thing that writes a Secret; the store does neither.
 * - Whether what is kept is encrypted is up to the backend.
 * - A backend only grows, so a Secret that is no longer used is still kept.
 */
export class Secrets {
  readonly #backend: Backend;

  constructor(backend: Backend) {
    this.#backend = backend;
  }

  get<T>(link: Link<T>): Promise<Bytes<T> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined>;
  get(link: Link<unknown>): Promise<Bytes<unknown> | undefined> {
    return blobIn(this.#backend, link);
  }

  async write({ roots, blobs }: Batch): Promise<void> {
    await this.#backend.put(await leavesFirst(roots, copiedBlobs(blobs), this.#backend), []);
  }
}
