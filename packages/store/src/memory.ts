import type { EncodedObject, Link } from "@estoc/object";
import type { Backend } from "./backend.ts";

export class MemoryBackend implements Backend {
  readonly #blobs = new Map<Link<unknown>, Uint8Array>();
  readonly #listedLinks = new Set<Link<EncodedObject>>();

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    const bytes = this.#blobs.get(link);
    return bytes && new Uint8Array(bytes);
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#blobs.has(link);
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, listedLinks: Iterable<Link<EncodedObject>>): Promise<void> {
    for (const [link, bytes] of blobs) if (!this.#blobs.has(link)) this.#blobs.set(link, bytes);
    for (const link of listedLinks) this.#listedLinks.add(link);
  }

  async *listedLinks(start = 0): AsyncIterable<Link<EncodedObject>> {
    yield* [...this.#listedLinks].slice(start);
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    yield* [...this.#blobs.keys()].slice(start);
  }
}
