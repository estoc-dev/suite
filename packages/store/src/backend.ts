import { type EncodedObject, type Link, linkOf } from "@estoc/object";

/**
 * Where a store keeps its blobs, and a private store or a secret store the list of its marks or of
 * its secrets as well: memory, a file, or storage in a browser. It keeps bytes and links as it is
 * given them; the store hashes and decodes, and hashes again what it gets back, so a backend that
 * was damaged makes reading fail.
 */
export interface Backend {
  /**
   * The bytes put under `link`, in an array the caller may change without
   * changing what is kept, or `undefined` when none were.
   */
  get(link: Link<unknown>): Promise<Uint8Array | undefined>;
  /** Whether bytes were put under `link`. */
  has(link: Link<unknown>): Promise<boolean>;
  /**
   * Puts each blob under its link, one after another in the order given, and then lists
   * `listedLinks`.
   *
   * - Each blob is given after the blobs it links to, and a link is listed only once its blob is
   *   in, so a write cut short leaves no blob without its closure and no listed link without its
   *   blob.
   * - The backend of a `Store` is given no links to list.
   * - The backend of a `PrivateStore` is given the blob of each link it lists. Part of a blob's
   *   closure may be in the store beside instead.
   * - The backend of a `SecretStore` is not given what the store beside it holds, so there these
   *   hold of the two together: part of a blob's closure, or the blob of a listed link, may be in
   *   the store beside instead.
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

/**
 * The bytes `backend` holds under `link`, or `undefined` when it holds none.
 *
 * @throws when the backend gives other bytes under the link.
 */
export async function blobIn(backend: Pick<Backend, "get">, link: Link<unknown>): Promise<Uint8Array | undefined> {
  const bytes = await backend.get(link);
  if (bytes !== undefined && linkOf(bytes) !== link) throw new Error(`the backend holds another blob under ${link}`);
  return bytes;
}
