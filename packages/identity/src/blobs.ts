import { type EncodedObject, type Link, linkOf } from "@estoc/object";

/**
 * The bytes of `object` and the closure of the schema it is written to, with `carried`, each
 * once however many of them share it. That is the closure of `object` when it links to nothing
 * but what `carried` holds, as an identity given the blobs of its keys and of the signed
 * identity it follows does.
 */
export function blobsOf(object: EncodedObject, carried: Iterable<Uint8Array> = []): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>([[object.link, object.bytes]]);
  for (const bytes of object.schema.blobs) blobs.set(linkOf(bytes), bytes);
  for (const bytes of carried) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
