import type { Link } from "@estoc/object";
import type { Backend } from "./backend.ts";

export class MemoryBackend implements Backend {
  readonly #blobs = new Map<Link<unknown>, Uint8Array>();

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    return this.#blobs.get(link);
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#blobs.has(link);
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Promise<void> {
    for (const [link, bytes] of blobs) if (!this.#blobs.has(link)) this.#blobs.set(link, bytes);
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    yield* [...this.#blobs.keys()].slice(start);
  }
}
