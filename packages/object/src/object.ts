import { decodeJson, encodeJson, isJsonObject, isLink, type Bytes, type Json, type Link } from "./encoding.ts";
import type { Schema } from "./schema.ts";

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
 * Reads an object written to `schema`. The caller names the schema it
 * expects, so an object written to any other is refused instead of read as
 * one of these.
 */
export function decodeObject(bytes: Bytes<EncodedObject>, schema: Schema): EncodedObject {
  const decoded = decodeJson(bytes);
  const { data, schema: named } = fieldsOf(decoded.value);
  if (named !== schema.link) throw new Error(`the object is not written to ${schema.link}`);
  const problems = schema.validate(data);
  if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
  return { schema, data, bytes: decoded.bytes, link: decoded.link };
}

export function encodeObject(schema: Schema, data: Json): EncodedObject {
  return decodeObject(encodeJson({ data, schema: schema.link }), schema);
}

/**
 * The link of the schema an object names, read before the object is: a
 * reader that takes objects of several schemas picks by it which schema to
 * read the object with.
 */
export function schemaOf(bytes: Bytes<EncodedObject>): Link<Schema> {
  const { schema } = fieldsOf(decodeJson(bytes).value);
  if (!isLink(schema)) throw new Error("an object names its schema by link");
  return schema;
}

function fieldsOf(value: Json): { readonly data: Json; readonly schema: Json } {
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
    throw new Error("an object has the fields data and schema");
  }
  return value as { data: Json; schema: Json };
}
