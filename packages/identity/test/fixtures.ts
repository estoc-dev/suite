import { type Link, linkOf, type ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { type CurveScheme, ed25519, eip191, loadIdentity, solanaOffchain } from "../src/index.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const freshKit = () => loadIdentity(schemes);
export const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));
export const identityVersionInHand = async <T>(inHand: T) => inHand;

/** A link with blobs that hold what it names, as a key or a signature read from an object has. */
interface LinkWithBlobs {
  readonly link: Link<unknown>;
  readonly blobs: readonly Uint8Array[];
}

export function bytesOf({ link, blobs }: LinkWithBlobs): Uint8Array {
  const bytes = blobs.find((each) => linkOf(each) === link);
  if (bytes === undefined) throw new Error(`the blobs of ${link} do not hold it`);
  return bytes;
}

/** The data of the object that `read` is read from, as the object format decodes it. */
export const dataOf = (read: LinkWithBlobs): ValueMap => objectFormat.decode(bytesOf(read)).data;

/** The link of the schema that the object `read` is read from is written to. */
export function schemaLinkOf(read: LinkWithBlobs): Link<unknown> {
  const { schema } = objectFormat.decode(bytesOf(read));
  return typeof schema === "string" ? schema : read.link;
}

// The closure a store gathers from a blob: the blob and every blob reached by
// the links the object format finds in it, past which a blob that is not an object links to nothing.
export function closure(link: Link<unknown>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Set<Link<unknown>> {
  const reached = new Set([link]);
  for (const next of reached) {
    const bytes = blobs.get(next);
    if (bytes === undefined) continue;
    let value: ObjectValue;
    try {
      value = objectFormat.decode(bytes);
    } catch {
      continue;
    }
    for (const linked of objectFormat.links(value)) reached.add(linked);
  }
  return reached;
}
