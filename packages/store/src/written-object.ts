import { type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import type { RecordBatch } from "./batch.ts";
import { memberObjectOf } from "./definition.ts";
import { type Index, recordedStatements } from "./source.ts";

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

const writtenObject = memberObjectOf(writtenObjectSchema);

/**
 * The Written Objects among the statements the store recorded. A row is encoded to the same bytes
 * as the Written Object it comes of, so the rows are those Written Objects.
 */
export const recordedWrittenObjects: Index<WrittenObjectData> = recordedStatements.rowsTaking(writtenObjectSchema, {
  object: writtenObject.field("object"),
  at: writtenObject.field("at"),
});
