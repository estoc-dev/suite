import { AbsentBlob, decodeObject, decodeSchema, type Link, type Reader, type Schema } from "@estoc/object";
import { rootSchema, type SchemaDocument, schemaLanguage, schemaValidator } from "@estoc/schema";

export interface ReadSchema {
  readonly schema: Schema;
  readonly document: SchemaDocument;
}

export async function readSchema(reader: Reader, link: Link<Schema>): Promise<ReadSchema> {
  const bytes = await reader.get(link);
  if (bytes === undefined) throw new AbsentBlob(link);
  return {
    schema: decodeSchema(bytes, schemaValidator),
    document: schemaLanguage.document(decodeObject(bytes, rootSchema).data),
  };
}
