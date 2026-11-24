import { type Link, linkOf } from "@estoc/object";

/**
 * - A backend keeps bytes as it is given them; the store hashes and decodes, and hashes again what
 *   it gets back, so a backend that was damaged makes reading fail.
 * - What puts blobs in a backend without a store, as what copies one to another does, is trusted
 *   with the Records among them.
 */
export interface Backend {
  get(link: Link<unknown>): Promise<Uint8Array | undefined>;
  has(link: Link<unknown>): Promise<boolean>;
  /**
   * Puts the blobs one after another in the order given. The store gives each after the blobs it
   * links to, so a write cut short keeps none without its closure.
   */
  put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Promise<void>;
  /**
   * The links of the blobs put, each once and in the order they were first put, leaving out the
   * first `start`.
   */
  blobs(start?: number): AsyncIterable<Link<unknown>>;
}

export async function blobIn(backend: Pick<Backend, "get">, link: Link<unknown>): Promise<Uint8Array | undefined> {
  const bytes = await backend.get(link);
  if (bytes !== undefined && linkOf(bytes) !== link) throw new Error(`the backend holds another blob under ${link}`);
  return bytes;
}
