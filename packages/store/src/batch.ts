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
 * A batch that a store, a private store or a secret store refuses for what it is.
 *
 * - One of its `marks` or `secrets` whose blob it does not give, or that is not an object: the
 *   same batch is refused again whatever comes to be held.
 * - One of its `roots`, or a blob in the closure of one of its `roots`, `marks` or `secrets`,
 *   that is neither in the batch nor held already: the same batch is refused again until what
 *   was missing is held.
 *
 * A backend that fails rejects with an error of its own, and may write the same batch the next
 * time.
 */
export class RefusedBatch extends Error {
  override readonly name = "RefusedBatch";
}

/**
 * Each is copied before it is hashed, so that what is kept is what was hashed, whatever happens to
 * the given arrays afterwards.
 */
export function copiedBlobs(blobs: Iterable<Bytes<unknown>>): Map<Link<unknown>, Uint8Array> {
  const batchBlobs = new Map<Link<unknown>, Uint8Array>();
  for (const blob of blobs) {
    const ownedBytes = new Uint8Array(blob);
    batchBlobs.set(linkOf(ownedBytes), ownedBytes);
  }
  return batchBlobs;
}

export function copiedBatch(
  links: Iterable<Link<unknown>>,
  blobs: Iterable<Bytes<unknown>>,
  listedAs: "a mark" | "a secret",
): { readonly blobs: Map<Link<unknown>, Uint8Array>; readonly objects: Link<EncodedObject>[] } {
  const batchBlobs = copiedBlobs(blobs);
  const objectLinks: Link<EncodedObject>[] = [];
  for (const link of links) {
    const bytes = batchBlobs.get(link);
    if (bytes === undefined) {
      throw new RefusedBatch(`${link} is written as ${listedAs} but is not among the blobs of the batch`);
    }
    try {
      schemaOf(bytes);
    } catch (cause) {
      throw new RefusedBatch(`${link} is written as ${listedAs} but is not an object`, { cause });
    }
    objectLinks.push(link as Link<EncodedObject>);
  }
  return { blobs: batchBlobs, objects: objectLinks };
}

export function linksIn(bytes: Uint8Array): Iterable<Link<unknown>> {
  let object: ObjectValue;
  try {
    object = objectFormat.decode(bytes);
  } catch {
    return [];
  }
  return objectFormat.links(object);
}

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
 * A blob that `backend` holds comes with its closure, so its links are not followed, apart from a
 * root that `blobs` gives as well.
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
