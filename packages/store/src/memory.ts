import type { Link } from "@estoc/object";
import type { Backend } from "./store.ts";

/** Keeps a store in memory, for tests and for a program that keeps nothing once it ends. */
export class MemoryBackend implements Backend {
  readonly #blobs = new Map<Link<unknown>, Uint8Array>();
  readonly #records = new Set<Link<never>>();

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes && new Uint8Array(bytes);
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#blobs.has(link);
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, records: Iterable<Link<never>>): Promise<void> {
    for (const [link, bytes] of blobs) this.#blobs.set(link, bytes);
    for (const link of records) this.#records.add(link);
  }

  async *records(start = 0): AsyncIterable<Link<never>> {
    yield* [...this.#records].slice(start);
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    yield* [...this.#blobs.keys()].slice(start);
  }
}
