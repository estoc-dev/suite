import { decodeBlob, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";
import type { Schema } from "./schema.ts";

/**
 * Data bound to the schema it is written to, as one blob in the encoding of
 * that schema. The same data under another schema is another object, with
 * another link. The data is of the type the schema declares.
 */
export interface EncodedObject<D, F extends Fields<D> = Fields<D>> {
  readonly schema: Schema<D, F>;
  readonly data: F;
  readonly bytes: Bytes<EncodedObject<D, F>>;
  readonly link: Link<EncodedObject<D, F>>;
}

/**
 * Blobs got by link: a store, a bundle, or a Map of blobs in memory. What a
 * reader gives under a link is checked against the link by whoever reads it.
 */
export interface Reader {
  get(link: Link<unknown>): Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

/**
 * Reads an object written to `schema`, and refuses it unless its data fits.
 * The caller names the schema it expects, so an object written to any other
 * is refused instead of read as one of these.
 */
export function decodeObject<D, F extends Fields<D>>(
  bytes: Bytes<EncodedObject<D, F>>,
  schema: Schema<D, F>,
): EncodedObject<D, F> {
  const { value, bytes: owned, link } = decodeBlob(schema.encoding, bytes);
  const fields = schema.encoding.fields(value);
  if (fields.schema !== schema.link)
    throw new Error(`the object is written to ${fields.schema}, not to ${schema.link}`);
  return { schema, data: schema.validate(fields.data), bytes: owned, link };
}

export function encodeObject<D, F extends Fields<D>>(
  schema: Schema<D, F>,
  data: F,
): EncodedObject<D, F> {
  return decodeObject(schema.encoding.encode(schema.encoding.object(data, schema.link)), schema);
}

/**
 * Reads the object that `link` names from `reader`, as `decodeObject` would.
 * Throws when the reader gives no blob for the link, or another blob.
 */
export async function readObject<D, F extends Fields<D>>(
  reader: Reader,
  link: Link<unknown>,
  schema: Schema<D, F>,
): Promise<EncodedObject<D, F>> {
  const bytes = await reader.get(link);
  if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
  const object = decodeObject(bytes, schema);
  if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
  return object;
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
