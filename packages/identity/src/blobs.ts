import { type EncodedObject, type Json, type Link, linkOf } from "@estoc/object";

/**
 * The bytes of `objects` and of the schemas they are written to, with
 * `carried`, each once however many of them share it. That is their closure
 * when they link to none but one another and what `carried` holds, as an
 * identity, its keys and the signed identity it follows do.
 */
export function blobsOf(objects: readonly EncodedObject<Json>[], carried: readonly Uint8Array[] = []): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  for (const { link, bytes } of objects) blobs.set(link, bytes);
  for (const { schema } of objects) blobs.set(schema.link, schema.bytes);
  for (const bytes of carried) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
