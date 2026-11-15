import {
  type Bytes,
  type EncodedObject,
  type Link,
  linkOf,
  type ObjectValue,
  objectFormat,
  type Reader,
  schemaOf,
} from "@estoc/object";
import type { Backend } from "./backend.ts";

/**
 * A batch that a store, a private store or a secret store refuses for what it is: one of its
 * `marks` or `secrets` that is not an object, or one of its `roots` or a blob in the closure of any
 * of these that is neither in the batch nor held already. The same batch is refused again until
 * what was missing is held, while a backend that fails, which rejects with an error of its own, may
 * write it the next time.
 */
export class RefusedBatch extends Error {
  override readonly name = "RefusedBatch";
}

/**
 * The blobs of a batch under their links. Each is copied before it is hashed, so that what is kept
 * is what was hashed, whatever happens to the given arrays afterwards.
 */
export function copiedBlobs(blobs: Iterable<Bytes<unknown>>): Map<Link<unknown>, Uint8Array> {
  const batchBlobs = new Map<Link<unknown>, Uint8Array>();
  for (const blob of blobs) {
    const ownedBytes = new Uint8Array(blob);
    batchBlobs.set(linkOf(ownedBytes), ownedBytes);
  }
  return batchBlobs;
}

/**
 * The blobs of a batch under their links, `objects` among them, and the links of `objects`, which
 * the batch is to list. Each is copied as `copiedBlobs` copies it.
 *
 * @throws {RefusedBatch} when one of `objects` is not an object, saying what the batch gave it to
 *   be `listedAs`.
 */
export function copiedBatch(
  objects: Iterable<{ readonly bytes: Bytes<unknown> }>,
  blobs: Iterable<Bytes<unknown>>,
  listedAs: "a mark" | "a secret",
): { readonly blobs: Map<Link<unknown>, Uint8Array>; readonly objects: Link<EncodedObject>[] } {
  const batchBlobs = copiedBlobs(blobs);
  const objectLinks: Link<EncodedObject>[] = [];
  for (const { bytes } of objects) {
    const ownedBytes: Bytes<EncodedObject> = new Uint8Array(bytes);
    const link = linkOf(ownedBytes);
    try {
      schemaOf(ownedBytes);
    } catch (cause) {
      throw new RefusedBatch(`${link} is written as ${listedAs} but is not an object`, { cause });
    }
    batchBlobs.set(link, ownedBytes);
    objectLinks.push(link);
  }
  return { blobs: batchBlobs, objects: objectLinks };
}

/** The links an object holds. Any other blob is bytes and links to nothing. */
export function linksIn(bytes: Uint8Array): Iterable<Link<unknown>> {
  let object: ObjectValue;
  try {
    object = objectFormat.decode(bytes);
  } catch {
    return [];
  }
  return objectFormat.links(object);
}

/**
 * The closure of the blob that `link` names, each blob of it as `reader` gives it.
 *
 * @throws when `reader` gives no blob of the closure, the one `link` names among them.
 */
export async function closureIn(reader: Reader, link: Link<unknown>): Promise<Map<Link<unknown>, Uint8Array>> {
  const closureBlobs = new Map<Link<unknown>, Uint8Array>();
  const seenLinks = new Set([link]);
  const pendingLinks = [link];
  for (let next = pendingLinks.pop(); next !== undefined; next = pendingLinks.pop()) {
    const bytes = await reader.get(next);
    if (bytes === undefined) throw new Error(`the store does not hold ${next}`);
    closureBlobs.set(next, bytes);
    for (const targetLink of linksIn(bytes)) {
      if (seenLinks.has(targetLink)) continue;
      seenLinks.add(targetLink);
      pendingLinks.push(targetLink);
    }
  }
  return closureBlobs;
}

/**
 * The blobs of `blobs` in the closures of `roots`, each after the blobs it links to. A blob that
 * `backend` holds comes with its closure, so its links are not followed, apart from a root that
 * `blobs` gives as well.
 *
 * @throws {RefusedBatch} when one of `roots`, or a blob in the closure of one, is neither in
 *   `blobs` nor held by `backend`.
 */
export async function leavesFirst(
  roots: Iterable<Link<unknown>>,
  blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
  backend: Pick<Backend, "has">,
): Promise<Map<Link<unknown>, Uint8Array>> {
  const orderedBlobs = new Map<Link<unknown>, Uint8Array>();
  const heldLinks = new Set<Link<unknown>>();
  const frame = (link: Link<unknown>, bytes: Uint8Array) => ({
    link,
    bytes,
    links: linksIn(bytes)[Symbol.iterator](),
  });
  for (const root of roots) {
    if (orderedBlobs.has(root)) continue;
    const rootBytes = blobs.get(root);
    if (rootBytes === undefined) {
      if (await backend.has(root)) continue;
      throw new RefusedBatch(`neither the batch nor the store holds ${root}, which the batch is to keep`);
    }
    // A link is a hash of its blob, so no blob on the path is in the closure of one after it.
    const path = [frame(root, rootBytes)];
    for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
      const next = top.links.next();
      if (next.done) {
        orderedBlobs.set(top.link, top.bytes);
        path.pop();
        continue;
      }
      const targetLink = next.value;
      if (orderedBlobs.has(targetLink) || heldLinks.has(targetLink)) continue;
      const targetBytes = blobs.get(targetLink);
      if (targetBytes !== undefined) {
        path.push(frame(targetLink, targetBytes));
      } else if (await backend.has(targetLink)) {
        heldLinks.add(targetLink);
      } else {
        throw new RefusedBatch(`${top.link} links to ${targetLink}, which neither the batch nor the store holds`);
      }
    }
  }
  return orderedBlobs;
}
