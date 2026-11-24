import { type EncodedObject, type Link, linkOf } from "@estoc/object";

export function distinctBlobsOf(object: EncodedObject, carried: Iterable<Uint8Array> = []): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>([[object.link, object.bytes]]);
  for (const bytes of object.schema.blobs) blobs.set(linkOf(bytes), bytes);
  for (const bytes of carried) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
