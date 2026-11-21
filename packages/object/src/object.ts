import { type Bytes, type Link, linkOf } from "./link.ts";
import { itself, ObjectValue, objectFormat, type ValueMap } from "./object-format.ts";
import type { Schema } from "./schema.ts";

export interface EncodedObject<F extends ValueMap = ValueMap> {
  readonly schema: Schema<F>;
  readonly data: F;
  readonly bytes: Bytes<EncodedObject<F>>;
  readonly link: Link<EncodedObject<F>>;
}

/**
 * - A reader gives under a link only the blob that the link names, or nothing, so what reads from
 *   it can look at the bytes before choosing how to read them.
 * - A reader whose bytes come from where they may have changed, such as a disk or the network,
 *   hashes them before it gives them.
 */
export interface Reader {
  get(link: Link<unknown>): Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

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

export class AbsentBlob extends Error {
  override readonly name = "AbsentBlob";
  readonly link: Link<unknown>;

  constructor(link: Link<unknown>) {
    super(`no blob is given for ${link}`);
    this.link = link;
  }
}

export async function readObject<F extends ValueMap>(
  reader: Reader,
  link: Link<unknown>,
  schema: Schema<F>,
): Promise<EncodedObject<F>> {
  return decodeObjectAt(link, await readBlob(reader, link), schema);
}

export async function readBlob(reader: Reader, link: Link<unknown>): Promise<Uint8Array> {
  const bytes = await reader.get(link);
  if (bytes === undefined) throw new AbsentBlob(link);
  return bytes;
}

export function decodeObjectAt<F extends ValueMap>(
  link: Link<unknown>,
  bytes: Bytes<EncodedObject<F>>,
  schema: Schema<F>,
): EncodedObject<F> {
  const object = decodeObject(bytes, schema);
  if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
  return object;
}

export function schemaOf(bytes: Bytes<unknown>): Link<Schema> {
  const { schema } = objectFormat.decode(bytes);
  return (schema === itself ? linkOf(bytes) : schema) as Link<Schema>;
}

export function namedSchemaOf(bytes: Bytes<unknown>): Link<Schema> | undefined {
  try {
    return schemaOf(bytes);
  } catch {
    return undefined;
  }
}
