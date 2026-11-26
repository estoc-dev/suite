import { AbsentBlob, decodeSchema, type Link, type Reader, type Schema } from "@estoc/object";

export async function readSchema(reader: Reader, link: Link<Schema>): Promise<Schema> {
  const bytes = await reader.get(link);
  if (bytes === undefined) throw new AbsentBlob(link);
  return decodeSchema(bytes);
}
