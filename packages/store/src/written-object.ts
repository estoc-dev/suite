import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import type { RecordBatch } from "./batch.ts";

/**
 * `at` is when `object` was written, in milliseconds since the Unix epoch, by the clock of the
 * device that wrote it.
 */
export const writtenObjectSchema = schema("Written Object", { object: link(), at: integer() });

export type WrittenObjectData = DataOf<typeof writtenObjectSchema>;

export type WrittenObject = EncodedObject<WrittenObjectData>;

export function writtenObjectsOf(objects: Iterable<Link<unknown>>, at: number): RecordBatch {
  const statements = Array.from(objects, (object) =>
    encodeObject(writtenObjectSchema, { object: new LinkValue(object), at }),
  );
  return {
    statements: statements.map(({ link }) => link),
    blobs: [...statements.map(({ bytes }) => bytes), ...writtenObjectSchema.blobs],
  };
}

const writtenObjects = objectsOf(writtenObjectSchema);

export async function objectWrittenIn(statement: Link<unknown>, reader: Reader): Promise<Link<unknown> | undefined> {
  return (await writtenObjects.read(statement, reader))?.data.object.link;
}
