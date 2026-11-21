import type { Bytes, Link } from "@estoc/object";
import type { Backend } from "./backend.ts";
import { copiedMarks, leavesFirst, refuseSecrets } from "./batch.ts";

export interface MarkBatch {
  readonly marks: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * - It is given the backend of the store whose blobs the marks link to, and that store reads and
 *   lists what is written here.
 * - An object of the schema of a mark that only came to the store, as in a bundle, is not a mark.
 *   The bytes of a mark, which anyone can send the store, change nothing of what is listed.
 * - Marks are not signed. That one is the user's own rests on what is handed this, which writes
 *   any mark, so it is no boundary between the programs that share it.
 */
export class Marks {
  readonly #backend: Backend;

  constructor(backend: Backend) {
    this.#backend = backend;
  }

  async write({ marks, blobs }: MarkBatch): Promise<void> {
    const batch = copiedMarks(marks, blobs);
    const keptBlobs = await leavesFirst(batch.marks, batch.blobs, this.#backend);
    refuseSecrets(keptBlobs);
    await this.#backend.put(keptBlobs, batch.marks);
  }
}
