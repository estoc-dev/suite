import { type Link, linkOf } from "./link.ts";
import type { Schema } from "./schema.ts";

/** The data of an object: fields, each a value of the encoding, by name. */
export type Fields<D> = { readonly [name: string]: D };

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
  /**
   * An object as one value: the fields of its data, and one field more,
   * which the encoding keeps for the link of the schema the data is written
   * to. Throws when the data has that field itself.
   */
  object(data: Fields<D>, schema: Link<Schema<D>>): D;
  /** The data and the schema link of a value that `object` gives; throws for any other value. */
  fields(value: D): { readonly data: Fields<D>; readonly schema: Link<Schema<D>> };
  /**
   * The links in a value, an object's schema included, so that what a blob
   * leads to can be gathered without reading it through a schema. It may
   * give more than the readers of the value follow, but leaves none out: a
   * reader checks each blob it follows, and a blob left out would be missing
   * when it is followed.
   */
  links(value: D): Iterable<Link<unknown>>;
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
export function decodeBlob<T>(
  codec: { decode(bytes: Uint8Array): T },
  bytes: Uint8Array,
): Decoded<T> {
  const owned = new Uint8Array(bytes);
  return { value: codec.decode(owned), bytes: owned, link: linkOf(owned) };
}
