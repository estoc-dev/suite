import { LRUCache } from "lru-cache";
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

interface DecodedBlob {
  readonly object: ObjectValue;
  /** The object names one schema, so whether its data fits is settled by the blob, whoever asks. */
  hasValidData: boolean;
}

/**
 * What the blob that a link names decodes to. A link names one blob, which does not change, so
 * nothing kept here goes stale, and a blob is kept only once its bytes were hashed to the link.
 */
const decodedBlobs = new LRUCache<Link<unknown>, DecodedBlob>({ max: 10_000 });

function keep(link: Link<unknown>, object: ObjectValue): DecodedBlob {
  const blob = { object, hasValidData: false };
  decodedBlobs.set(link, blob);
  return blob;
}

function schemaLinkOf(object: ObjectValue, link: Link<unknown>): Link<Schema> {
  return (object.schema === itself ? link : object.schema) as Link<Schema>;
}

/**
 * `bytes` are what a reader gave for `link`. They are decoded and hashed the first time; after
 * that, what is kept under the link is given without a look at them.
 */
export function objectValueAt(link: Link<unknown>, bytes: Uint8Array): ObjectValue {
  const kept = decodedBlobs.get(link);
  if (kept !== undefined) return kept.object;
  const object = objectFormat.decode(bytes);
  if (linkOf(bytes) !== link) throw new Error(`the blob given for ${link} is another blob`);
  return keep(link, object).object;
}

function encodedObjectAt<F extends ValueMap>(
  link: Link<unknown>,
  hashedBytes: Bytes<EncodedObject<F>>,
  schema: Schema<F>,
): EncodedObject<F> {
  const blob = decodedBlobs.get(link) ?? keep(link, objectFormat.decode(hashedBytes));
  const schemaLink = schemaLinkOf(blob.object, link);
  if (schemaLink !== schema.link) throw new Error(`the object is written to ${schemaLink}, not to ${schema.link}`);
  if (!blob.hasValidData) {
    schema.validate(blob.object.data);
    blob.hasValidData = true;
  }
  return { schema, data: blob.object.data as F, bytes: hashedBytes, link: link as Link<EncodedObject<F>> };
}

export function decodeObject<F extends ValueMap>(bytes: Bytes<EncodedObject<F>>, schema: Schema<F>): EncodedObject<F> {
  return encodedObjectAt(linkOf(bytes), bytes, schema);
}

export function encodeObject<F extends ValueMap>(
  schema: Schema<F>,
  data: F,
): EncodedObject<F> & { readonly bytes: Uint8Array<ArrayBuffer> } {
  const bytes = objectFormat.encode(new ObjectValue(schema.link, data));
  return { ...decodeObject(bytes, schema), bytes };
}

export function blobsOf(object: EncodedObject): Uint8Array[] {
  return [object.bytes, ...object.schema.blobs];
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
  if (linkOf(bytes) !== link) throw new Error(`the blob given for ${link} is another blob`);
  return encodedObjectAt(link, bytes, schema);
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

export function schemaAt(link: Link<unknown>, bytes: Uint8Array): Link<Schema> {
  return schemaLinkOf(objectValueAt(link, bytes), link);
}

export function namedSchemaAt(link: Link<unknown>, bytes: Uint8Array): Link<Schema> | undefined {
  try {
    return schemaAt(link, bytes);
  } catch {
    return undefined;
  }
}
