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
  /** @throws when the encoding cannot write `value`. */
  encode(value: D): Uint8Array;
  /**
   * Reads the value that `bytes` hold. It needs nothing but the bytes, so the
   * schema an object names can be read before the schema is.
   *
   * @throws when the bytes are not exactly what `encode` writes for that
   * value, so that a value has one encoding and one link.
   */
  decode(bytes: Uint8Array): D;
  /**
   * An object as one value: the fields of its data, and one field more,
   * which the encoding keeps for the link of the schema the data is written
   * to, or for `null` in an object that describes itself.
   *
   * @throws when `data` has that field itself.
   */
  object(data: Fields<D>, schema: Link<unknown> | null): D;
  /**
   * The data and the schema of a value that `object` gives.
   *
   * @throws for any other value, which is not an object but bytes.
   */
  fields(value: D): { readonly data: Fields<D>; readonly schema: Link<Schema<D>> | null };
  /**
   * The links in an object, its schema included, so that a blob's closure
   * can be gathered without reading it through a schema.
   *
   * - A value that is not an object is bytes, and links to nothing whatever it holds.
   * - It may give more than the readers of the object follow, but leaves none out: a reader checks
   *   each blob it follows, and a blob left out would be missing when it is followed.
   */
  links(value: D): Iterable<Link<unknown>>;
}

export interface DecodedBlob<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
  readonly link: Link<never>;
}

/**
 * Decodes a copy of `bytes`, so that what was read is what is kept, whatever
 * happens to the given array afterwards.
 */
export function decodeBlob<T>(codec: { decode(bytes: Uint8Array): T }, bytes: Uint8Array): DecodedBlob<T> {
  const owned = new Uint8Array(bytes);
  return { value: codec.decode(owned), bytes: owned, link: linkOf(owned) };
}
