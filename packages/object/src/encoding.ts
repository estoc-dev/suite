import { linkOf, type Link } from "./link.ts";
import type { Schema } from "./schema.ts";

/**
 * A model of data and the one way each of its values is written as bytes,
 * of which objects are made. JSON with JCS is one; deterministic CBOR would
 * be another. Two encodings of the same content are two blobs with two
 * links, and neither reads as the other.
 */
export interface Encoding<D> {
  /** Throws for a value the encoding cannot write. */
  encode(value: D): Uint8Array;
  /**
   * Reads bytes that are exactly what `encode` writes for the value they
   * hold, and refuses any other, so that a value has one encoding and one
   * link. It needs nothing but the bytes, so the schema an object names can
   * be read before the schema is.
   */
  decode(bytes: Uint8Array): D;
  /** An object as one value: its data, and the link of the schema it is written to. */
  object(data: D, schema: Link<Schema<D>>): D;
  /** The data and the schema link of a value that `object` gives; throws for any other value. */
  fields(value: D): { readonly data: D; readonly schema: Link<Schema<D>> };
}

export interface Decoded<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
  readonly link: Link<never>;
}

/**
 * Decodes a copy of `bytes`, so that what was read is what is kept, whatever
 * happens to the given array afterwards.
 */
export function decodeBlob<T>(codec: { decode(bytes: Uint8Array): T }, bytes: Uint8Array): Decoded<T> {
  const owned = new Uint8Array(bytes);
  return { value: codec.decode(owned), bytes: owned, link: linkOf(owned) };
}
