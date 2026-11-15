import {
  type Bytes,
  type EncodedObject,
  type Link,
  linkOf,
  type ObjectValue,
  objectFormat,
  schemaOf,
} from "@estoc/object";
import type { Backend } from "./backend.ts";

/**
 * A batch that a store or a private store refuses for what it is: one of its `records` or `marks`
 * that is not an object, or a blob in the closure of one that is neither in the batch nor held
 * already. The same batch is refused again until what was missing is held, while a backend that
 * fails, which rejects with an error of its own, may write it the next time.
 */
export class RefusedBatch extends Error {
  override readonly name = "RefusedBatch";
}

/**
 * The blobs of a batch under their links, `objects` among them, and the links of `objects`. Each is
 * copied before it is hashed, so that what is kept is what was hashed, whatever happens to the
 * given arrays afterwards.
 *
 * @throws {RefusedBatch} when one of `objects` is not an object, saying what the batch gave it to
 *   be `listedAs`.
 */
export function copiedBatch(
  objects: Iterable<{ readonly bytes: Bytes<unknown> }>,
  blobs: Iterable<Bytes<unknown>>,
  listedAs: "recorded" | "marked",
): { readonly blobs: Map<Link<unknown>, Uint8Array>; readonly objects: Link<EncodedObject>[] } {
  const batchBlobs = new Map<Link<unknown>, Uint8Array>();
  for (const blob of blobs) {
    const ownedBytes = new Uint8Array(blob);
    batchBlobs.set(linkOf(ownedBytes), ownedBytes);
  }
  const objectLinks: Link<EncodedObject>[] = [];
  for (const { bytes } of objects) {
    const ownedBytes: Bytes<EncodedObject> = new Uint8Array(bytes);
    const link = linkOf(ownedBytes);
    try {
      schemaOf(ownedBytes);
    } catch (cause) {
      throw new RefusedBatch(`${link} is ${listedAs} but is not an object`, { cause });
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
 * `listed`, which are among `blobs`, and the blobs of `blobs` in their closures, each after the
 * blobs it links to. A blob that `backend` holds comes with its closure, so its links are not
 * followed.
 *
 * @throws {RefusedBatch} when a blob in the closure of one of `listed` is neither in `blobs` nor
 *   held by `backend`.
 */
export async function leavesFirst(
  listed: readonly Link<unknown>[],
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
  for (const start of listed) {
    if (orderedBlobs.has(start)) continue;
    // A link is a hash of its blob, so no blob on the path is in the closure of one after it.
    // biome-ignore lint/style/noNonNullAssertion: each listed link is among the blobs
    const path = [frame(start, blobs.get(start)!)];
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
