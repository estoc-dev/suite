import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import type { MarkBatch } from "./marks.ts";

/**
 * - `at` is when the user wrote the object, in milliseconds since the Unix epoch, by the clock of
 *   the device that wrote the record.
 * - Anyone can write an object of this schema. It is a record only where `Marks` listed it.
 */
export const recordSchema = schema("Record", { object: link(), at: integer() });

export type RecordData = DataOf<typeof recordSchema>;

export type RecordObject = EncodedObject<RecordData>;

export function recordsOf(objects: Iterable<Link<unknown>>, at: number): MarkBatch {
  const marks = Array.from(objects, (object) => encodeObject(recordSchema, { object: new LinkValue(object), at }));
  return { marks: marks.map(({ link }) => link), blobs: [...marks.map(({ bytes }) => bytes), ...recordSchema.blobs] };
}

const records = objectsOf(recordSchema);

export async function objectRecordedAt(listedLink: Link<unknown>, reader: Reader): Promise<Link<unknown> | undefined> {
  return (await records.read(listedLink, reader))?.data.object.link;
}
