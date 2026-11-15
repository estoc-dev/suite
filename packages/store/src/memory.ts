import type { EncodedObject, Link } from "@estoc/object";
import type { Backend } from "./backend.ts";

/** Keeps a store in memory, for tests and for a program that keeps nothing once it ends. */
export class MemoryBackend implements Backend {
  readonly #blobs = new Map<Link<unknown>, { readonly bytes: Uint8Array; readonly position: number }>();
  readonly #listedLinks = new Set<Link<EncodedObject>>();

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    const blob = this.#blobs.get(link);
    return blob && new Uint8Array(blob.bytes);
  }

  async has(link: Link<unknown>): Promise<boolean> {
    return this.#blobs.has(link);
  }

  async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, listedLinks: Iterable<Link<EncodedObject>>): Promise<void> {
    for (const [link, bytes] of blobs)
      if (!this.#blobs.has(link)) this.#blobs.set(link, { bytes, position: this.#blobs.size });
    for (const link of listedLinks) this.#listedLinks.add(link);
  }

  async *listedLinks(start = 0): AsyncIterable<Link<EncodedObject>> {
    yield* [...this.#listedLinks].slice(start);
  }

  async *blobs(start = 0): AsyncIterable<Link<unknown>> {
    yield* [...this.#blobs.keys()].slice(start);
  }

  async positionOf(link: Link<unknown>): Promise<number | undefined> {
    return this.#blobs.get(link)?.position;
  }
}
