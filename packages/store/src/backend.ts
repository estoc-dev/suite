import { type EncodedObject, type Link, linkOf } from "@estoc/object";

/**
 * - A backend keeps bytes and links as it is given them; the store hashes and decodes, and hashes
 *   again what it gets back, so a backend that was damaged makes reading fail.
 * - A store, and the `Marks` and `Secrets` that write what it reads, are given one backend. What
 *   is given the backend itself reads and writes all of it, Secrets and marks as well.
 */
export interface Backend {
  /** Gives an array the caller may change without changing what is kept. */
  get(link: Link<unknown>): Promise<Uint8Array | undefined>;
  has(link: Link<unknown>): Promise<boolean>;
  /**
   * Puts the blobs one after another in the order given, and then lists `listedLinks`, so that a
   * write cut short lists nothing whose closure was not kept.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, listedLinks: Iterable<Link<EncodedObject>>): Promise<void>;
  /**
   * The links listed by `put`, each once and in the order they were first listed, leaving out the
   * first `start`.
   */
  listedLinks(start?: number): AsyncIterable<Link<EncodedObject>>;
  /**
   * The links of the blobs put, each once and in the order they were first put, leaving out the
   * first `start`. A write cut short can leave blobs here that no listed link reaches.
   */
  blobs(start?: number): AsyncIterable<Link<unknown>>;
}

export async function blobIn(backend: Pick<Backend, "get">, link: Link<unknown>): Promise<Uint8Array | undefined> {
  const bytes = await backend.get(link);
  if (bytes !== undefined && linkOf(bytes) !== link) throw new Error(`the backend holds another blob under ${link}`);
  return bytes;
}
