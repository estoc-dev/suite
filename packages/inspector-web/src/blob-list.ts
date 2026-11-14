import type { Bundle } from "@estoc/bundle";
import { type Inspection, inspect } from "@estoc/inspector";
import { type Link, linkOf } from "@estoc/object";

/** A blob that a bundle holds. */
export interface ListedBlob {
  readonly bytes: Uint8Array;
  /** What the blob reads as through the bundle. */
  readonly inspection: Inspection;
  readonly isRoot: boolean;
  /**
   * Whether following links from the root comes to the blob, through blobs the bundle holds.
   *
   * A blob that is not reached may still be in the closure of the root: a bundle can leave out a
   * blob of that closure, and what the blob left out links to is not known.
   */
  readonly isReachedFromRoot: boolean;
}

/**
 * The blobs of a bundle as it orders them: the root, then the blobs carried with it.
 *
 * The links of a blob are those its inspection gives: the schema it names and the links in its data.
 */
export async function blobListOf(bundle: Bundle): Promise<readonly ListedBlob[]> {
  const blobs = await Promise.all(
    Array.from(bundle.blobs(), async (bytes) => ({ bytes, inspection: await inspect(linkOf(bytes), bundle) })),
  );
  const inspectionAt = new Map(blobs.map(({ inspection }) => [inspection.link, inspection]));
  const reachedLinks = new Set<Link<unknown>>();
  const next: Link<unknown>[] = [bundle.link];
  for (let link = next.pop(); link !== undefined; link = next.pop()) {
    const inspection = inspectionAt.get(link);
    if (inspection === undefined || reachedLinks.has(link)) continue;
    reachedLinks.add(link);
    if (inspection.kind !== "object") continue;
    next.push(inspection.schema.link);
    for (const dataLink of inspection.links) next.push(dataLink.link);
  }
  return blobs.map(({ bytes, inspection }) => ({
    bytes,
    inspection,
    isRoot: inspection.link === bundle.link,
    isReachedFromRoot: reachedLinks.has(inspection.link),
  }));
}
