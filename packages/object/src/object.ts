import { decodeJson, isLink, type Bytes, type Json, type Link } from "./encoding.ts";
import type { Schema } from "./schema.ts";
import { fieldsOf, reading, View } from "./view.ts";

/**
 * A JSON value bound to the schema it is written to, as one blob:
 * `{"data": <value>, "schema": <link to the schema>}`. The same value under
 * another schema is another object, with another link.
 */
export interface EncodedObject {
  readonly schema: Schema;
  readonly data: Json;
  readonly bytes: Bytes<EncodedObject>;
  readonly link: Link<EncodedObject>;
}

/**
 * Reads an object written to `schema`, its data left as JSON. The caller
 * names the schema it expects, so an object written to any other is refused
 * instead of read as one of these.
 */
export function decodeObject(bytes: Bytes<EncodedObject>, schema: Schema): EncodedObject {
  return viewOf(schema).decode(bytes);
}

export function encodeObject(schema: Schema, data: Json): EncodedObject {
  return viewOf(schema).encode(schema.link, data);
}

function viewOf(schema: Schema): View<EncodedObject> {
  return new View([reading(schema, (data, object) => ({ schema, data, ...object }))]);
}

/**
 * The link of the schema an object names, read before the object is: a
 * reader that takes objects of several schemas picks by it which schema to
 * read the object with.
 */
export function schemaOf(bytes: Bytes<unknown>): Link<Schema> {
  const { schema } = fieldsOf(decodeJson(bytes).value);
  if (!isLink(schema)) throw new Error("an object names its schema by link");
  return schema;
}
