import { type Bytes, type Link, linkOf } from "./link.ts";
import { itself, ObjectValue, objectFormat, type ValueMap } from "./object-format.ts";
import type { Schema } from "./schema.ts";

/**
 * Data bound to the schema it is written to, as one blob of the object
 * format. The same data under another schema is another object, with
 * another link.
 */
export interface EncodedObject<F extends ValueMap = ValueMap> {
  readonly schema: Schema<F>;
  readonly data: F;
  readonly bytes: Bytes<EncodedObject<F>>;
  readonly link: Link<EncodedObject<F>>;
}

/**
 * Blobs got by link: a store, a bundle, or a Map of blobs in memory.
 *
 * - A reader gives under a link only the blob that the link names, or nothing, so what reads from
 *   it can look at the bytes before choosing how to read them.
 * - A reader whose bytes come from where they may have changed, such as a disk or the network,
 *   hashes them before it gives them.
 */
export interface Reader {
  get(link: Link<unknown>): Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

/**
 * Reads an object written to `schema`. The caller names the schema it
 * expects, so an object written to any other is refused instead of read as
 * one of these.
 *
 * @throws when the bytes are not an object, when the object is written to
 * another schema, or when its data does not fit.
 */
export function decodeObject<F extends ValueMap>(bytes: Bytes<EncodedObject<F>>, schema: Schema<F>): EncodedObject<F> {
  // A copy, so that what was read is what is kept, whatever happens to the given array afterwards.
  const owned = new Uint8Array(bytes);
  const object = objectFormat.decode(owned);
  const link = linkOf(owned);
  const schemaLink = object.schema === itself ? link : object.schema;
  if (schemaLink !== schema.link) throw new Error(`the object is written to ${schemaLink}, not to ${schema.link}`);
  return { schema, data: schema.validate(object.data), bytes: owned, link };
}

export function encodeObject<F extends ValueMap>(schema: Schema<F>, data: F): EncodedObject<F> {
  return decodeObject(objectFormat.encode(new ObjectValue(schema.link, data)), schema);
}

/**
 * Reads the object that `link` names from `reader`, as `decodeObject` would.
 *
 * @throws when the reader gives no blob for `link`, or another blob, and
 * wherever `decodeObject` throws.
 */
export async function readObject<F extends ValueMap>(
  reader: Reader,
  link: Link<unknown>,
  schema: Schema<F>,
): Promise<EncodedObject<F>> {
  return decodeObjectAt(link, await readBlob(reader, link), schema);
}

export async function readBlob(reader: Reader, link: Link<unknown>): Promise<Uint8Array> {
  const bytes = await reader.get(link);
  if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
  return bytes;
}

/**
 * Reads `bytes`, given for `link`, as `decodeObject` does.
 *
 * @throws when the bytes are another blob than the one `link` names.
 */
export function decodeObjectAt<F extends ValueMap>(
  link: Link<unknown>,
  bytes: Bytes<EncodedObject<F>>,
  schema: Schema<F>,
): EncodedObject<F> {
  const object = decodeObject(bytes, schema);
  if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
  return object;
}

/**
 * The link of the schema an object names, read before the object is: a
 * program that takes objects of several schemas picks by it which schema to
 * read the object with. For an object written to itself, it is the link of
 * the bytes.
 *
 * @throws when the bytes are not an object.
 */
export function schemaOf(bytes: Bytes<unknown>): Link<Schema> {
  const { schema } = objectFormat.decode(bytes);
  return (schema === itself ? linkOf(bytes) : schema) as Link<Schema>;
}
