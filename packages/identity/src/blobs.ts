import { type EncodedObject, type Json, type Link, linkOf, type Schema } from "@estoc/object";

/**
 * The bytes of `objects` and the blobs of the schemas they are written to,
 * with `carried`, each once. That is their closure when they link to none
 * but one another and what `carried` holds, as an identity, its keys and the
 * signed identity it follows do. Keys of one scheme share a schema, schemas
 * share the blobs of their languages, and the identity versions of a chain
 * share their schemas and keys, yet each blob is carried once.
 */
export function blobsOf(objects: readonly EncodedObject<Json>[], carried: readonly Uint8Array[] = []): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  const schemas = new Map<Link<unknown>, Schema<Json>>();
  for (const { link, bytes, schema } of objects) {
    blobs.set(link, bytes);
    schemas.set(schema.link, schema);
  }
  for (const schema of schemas.values()) for (const bytes of schema.blobs) blobs.set(linkOf(bytes), bytes);
  for (const bytes of carried) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
