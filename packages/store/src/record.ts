import { type EncodedObject, encodeObject, type Link, LinkValue, namedSchemaAt } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";

/**
 * A Record says that the programs that share the store said the statement it links to. What the
 * statement means, and when it was said, are for the schema of the statement to say.
 *
 * Anyone can encode an object of this schema, so a Record counts for where it is: a store writes
 * the Records it encodes itself and refuses every other.
 */
export const recordSchema = schema("Record", { object: link<EncodedObject>() });

export type RecordData = DataOf<typeof recordSchema>;

export type RecordObject = EncodedObject<RecordData>;

export function recordOf(statement: Link<EncodedObject>): RecordObject {
  return encodeObject(recordSchema, { object: new LinkValue(statement) });
}

export function isRecord(link: Link<unknown>, bytes: Uint8Array): boolean {
  return namedSchemaAt(link, bytes) === recordSchema.link;
}
