import { type EncodedObject, type Link, linkOf } from "@estoc/object";

/**
 * The bytes of `objects` and the closures of the schemas they are written to,
 * with `carried`, each once however many of them share it. That is their closure
 * when they link to none but one another and what `carried` holds, as an
 * identity, its keys and the signed identity it follows do.
 */
export function blobsOf(objects: readonly EncodedObject[], carried: readonly Uint8Array[] = []): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  for (const { link, bytes } of objects) blobs.set(link, bytes);
  for (const { schema } of objects) for (const bytes of schema.blobs) blobs.set(linkOf(bytes), bytes);
  for (const bytes of carried) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
