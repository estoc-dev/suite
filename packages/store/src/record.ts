import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import type { MarkBatch } from "./private-store.ts";

/**
 * The schema of a record: the mark that the user of a store wrote an object.
 *
 * - `object` is the link of the object the user wrote.
 * - `at` is when the user wrote it, in milliseconds since the Unix epoch, by the clock of the device
 *   that wrote the record. So an object written again is recorded again, with the time then.
 * - Anyone can write an object of this schema. It is a record only where it is listed, among the
 *   marks of a private store.
 */
export const recordSchema = schema("Record", { object: link<EncodedObject>(), at: integer() });

export type RecordData = DataOf<typeof recordSchema>;

export type RecordObject = EncodedObject<RecordData>;

/**
 * A record that each of `objects` was written at `at`, with the blobs of `recordSchema`, to write
 * to the private store beside the store that holds the objects. An index over `selectedRecords`
 * then reads them from the private store, each once however many records link to it.
 */
export function recordsOf(objects: Iterable<{ readonly link: Link<EncodedObject> }>, at: number): MarkBatch {
  const marks = Array.from(objects, (object) => encodeObject(recordSchema, { object: new LinkValue(object.link), at }));
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
