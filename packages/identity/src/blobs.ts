import { type EncodedObject, type Json, type Link, linkOf, type Schema } from "@estoc/object";

/**
 * The bytes of `objects` and the blobs of the schemas they are written to,
 * each once. That is their closure when they link to none but one another,
 * as an identity and its keys do. A key can be both root and agent, keys of
 * one scheme share a schema, and schemas share the blobs of their languages,
 * yet each blob is carried once.
 */
export function blobsOf(objects: readonly EncodedObject<Json>[]): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  const schemas = new Map<Link<unknown>, Schema<Json>>();
  for (const { link, bytes, schema } of objects) {
    blobs.set(link, bytes);
    schemas.set(schema.link, schema);
  }
  for (const schema of schemas.values()) for (const bytes of schema.blobs) blobs.set(linkOf(bytes), bytes);
  return [...blobs.values()];
}
