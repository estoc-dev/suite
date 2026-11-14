import { type EncodedObject, type Link, type Reader, readObject } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";

/**
 * The schema of a record: the mark that the user of a store wrote an object.
 *
 * - `object` is the link of the object the user wrote.
 * - A record says nothing else, so writing an object again gives the same record.
 * - Anyone can write an object of this schema. It is a record of a store only where the store
 *   lists it.
 */
export const recordSchema = schema("Record", { object: link<EncodedObject>() });

export type RecordData = DataOf<typeof recordSchema>;

export type RecordObject = EncodedObject<RecordData>;

/**
 * The links of the objects that `records` link to, in the order of the records, each record read
 * from `reader`.
 *
 * @throws when `reader` gives no blob for a record, or one that is not an object of `recordSchema`.
 */
export async function* objectsRecordedBy(
  records: AsyncIterable<Link<unknown>>,
  reader: Reader,
): AsyncIterable<Link<EncodedObject>> {
  for await (const record of records) yield (await readObject(reader, record, recordSchema)).data.object.link;
}
