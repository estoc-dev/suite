import type { Encoding, Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";
import type { Schema } from "./schema.ts";
import { Semantics } from "./semantics.ts";

/**
 * Data bound to the schema it is written to, as one blob in the encoding of
 * that schema. The same data under another schema is another object, with
 * another link.
 */
export interface EncodedObject<D> {
  readonly schema: Schema<D>;
  readonly data: Fields<D>;
  readonly bytes: Bytes<EncodedObject<D>>;
  readonly link: Link<EncodedObject<D>>;
}

/**
 * Reads an object written to `schema`, its data left as the encoding reads
 * it. The caller names the schema it expects, so an object written to any
 * other is refused instead of read as one of these.
 */
export function decodeObject<D>(bytes: Bytes<EncodedObject<D>>, schema: Schema<D>): EncodedObject<D> {
  return semanticsOf(schema).decode(bytes);
}

export function encodeObject<D>(schema: Schema<D>, data: Fields<D>): EncodedObject<D> {
  return semanticsOf(schema).encode(data);
}

function semanticsOf<D>(schema: Schema<D>): Semantics<EncodedObject<D>, Fields<D>> {
  return new Semantics([{ schema, read: (data, object) => ({ schema, data, ...object }) }], {
    schema: schema.link,
    write: (data) => data,
  });
}

/**
 * The link of the schema an object names, read before the object is: a
 * reader that takes objects of several schemas picks by it which schema to
 * read the object with. With no schema yet to say so, the caller names the
 * encoding of the object.
 */
export function schemaOf<D>(bytes: Bytes<unknown>, encoding: Encoding<D>): Link<Schema<D>> {
  return encoding.fields(encoding.decode(bytes)).schema;
}
