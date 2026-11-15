import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import type { MarkBatch } from "./private-store.ts";

/**
 * The schema of a record: the mark that the user of a store wrote an object.
 *
 * - `object` is the link of the object the user wrote.
 * - A record says nothing else, so writing an object again gives the same record.
 * - Anyone can write an object of this schema. It is a record only where it is listed, among the
 *   marks of a private store.
 */
export const recordSchema = schema("Record", { object: link<EncodedObject>() });

export type RecordData = DataOf<typeof recordSchema>;

export type RecordObject = EncodedObject<RecordData>;

/**
 * A record of each of `objects` with the blobs of `recordSchema`, to write to the private store
 * beside the store that holds the objects. An index over `selectedRecords` then reads them from the
 * private store.
 */
export function recordsOf(objects: Iterable<{ readonly link: Link<EncodedObject> }>): MarkBatch {
  const marks = Array.from(objects, (object) => encodeObject(recordSchema, { object: new LinkValue(object.link) }));
  return { marks, blobs: recordSchema.blobs };
}

const records = objectsOf(recordSchema);

/**
 * The link of the object that the record `listedLink` names links to, or `undefined` when it names
 * an object of another schema, as most marks are.
 *
 * @throws when `reader` gives no blob for `listedLink`, or one that is not an object.
 */
export async function objectRecordedAt(
  listedLink: Link<unknown>,
  reader: Reader,
): Promise<Link<EncodedObject> | undefined> {
  return (await records.read(listedLink, reader))?.data.object.link;
}
