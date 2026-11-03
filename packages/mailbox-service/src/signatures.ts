import type { SignatureData } from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  type Fields,
  type Json,
  type Reader,
  type Schema,
  schemaOf,
} from "@estoc/object";

/**
 * The object that `signature` is over, read with `schema`, or `undefined`
 * when the object is written to another schema or `reader` does not hold it.
 */
export async function objectOf<D, F extends Fields<D>>(
  signature: EncodedObject<Json, SignatureData>,
  reader: Reader,
  schema: Schema<D, F>,
): Promise<EncodedObject<D, F> | undefined> {
  const bytes = await reader.get(signature.data.object.$link);
  if (bytes === undefined || schemaOf(bytes, schema.encoding) !== schema.link) return undefined;
  return decodeObject(bytes, schema);
}
