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
import { type Backend, blobIn } from "./backend.ts";
import { isRecord, recordOf, recordSchema } from "./record.ts";

export interface Batch {
  readonly roots: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

export interface RecordBatch {
  readonly statements: Iterable<Link<unknown>>;
  readonly blobs: Iterable<Bytes<unknown>>;
}

/**
 * A batch that a store refuses for what it is.
 *
 * - A Record among its blobs, one of its `statements` whose blob it does not give or that is not
 *   an object, or a link to a Record from a blob it is to keep: the same batch is refused again
 *   whatever comes to be held.
 * - One of its `roots`, or a blob in the closure of one of its `roots` or `statements`, that is
 *   neither in the batch nor held already: the same batch is refused again until what was missing
 *   is held.
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
    const link = linkOf(ownedBytes);
    if (isRecord(ownedBytes)) throw new RefusedBatch(`${link} is a Record, which a batch does not give`);
    batchBlobs.set(link, ownedBytes);
  }
  return batchBlobs;
}

/** The copies of the blobs of a batch, with the links of every Record among them. */
export interface CopiedBatch {
  readonly blobs: ReadonlyMap<Link<unknown>, Uint8Array>;
  readonly records: readonly Link<unknown>[];
}

export function recordsOf({ statements, blobs }: RecordBatch): CopiedBatch {
  const batchBlobs = copiedBlobs([...blobs, ...recordSchema.blobs]);
  const records: EncodedObject[] = [];
  for (const statement of statements) {
    const bytes = batchBlobs.get(statement);
    if (bytes === undefined) {
      throw new RefusedBatch(`${statement} is recorded but is not among the blobs of the batch`);
    }
    try {
      schemaOf(bytes);
    } catch (cause) {
      throw new RefusedBatch(`${statement} is recorded but is not an object`, { cause });
    }
    records.push(recordOf(statement as Link<EncodedObject>));
  }
  for (const { link, bytes } of records) batchBlobs.set(link, bytes);
  return { blobs: batchBlobs, records: records.map(({ link }) => link) };
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
 * - A blob that `backend` holds comes with its closure, so its links are not followed, apart from
 *   a root that `blobs` gives as well.
 * - Nothing links to a Record, so that none leaves in the closure of another object. A blob that
 *   `backend` holds is read for that, where asking whether it is held would do otherwise.
 */
export async function leavesFirst(
  roots: Iterable<Link<unknown>>,
  { blobs, records }: CopiedBatch,
  backend: Pick<Backend, "get" | "has">,
): Promise<Map<Link<unknown>, Uint8Array>> {
  const orderedBlobs = new Map<Link<unknown>, Uint8Array>();
  const heldLinks = new Set<Link<unknown>>();
  const recordLinks = new Set(records);
  const linkToRecord = (from: Link<unknown>, record: Link<unknown>) =>
    new RefusedBatch(`${from} links to ${record}, which is a Record`);
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
      if (recordLinks.has(targetLink)) throw linkToRecord(top.link, targetLink);
      if (orderedBlobs.has(targetLink) || heldLinks.has(targetLink)) continue;
      const batchBytes = blobs.get(targetLink);
      if (batchBytes !== undefined) {
        path.push(frame(targetLink, batchBytes));
        continue;
      }
      const heldBytes = await blobIn(backend, targetLink);
      if (heldBytes === undefined) {
        throw new RefusedBatch(`${top.link} links to ${targetLink}, which neither the batch nor the store holds`);
      }
      if (isRecord(heldBytes)) throw linkToRecord(top.link, targetLink);
      heldLinks.add(targetLink);
    }
  }
  return orderedBlobs;
}
