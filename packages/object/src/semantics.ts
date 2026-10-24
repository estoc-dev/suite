import { decodeBlob, type Decoded, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";
import type { Schema } from "./schema.ts";

/** Blobs by their links: a Map, a bundle, or a store that holds blobs by content. */
export interface Blobs {
  get(link: Link<unknown>): Uint8Array | undefined;
}

const noBlobs: Blobs = { get: () => undefined };

/**
 * One way of reading the objects written to one schema: their data, and the
 * bytes and link of the object, become a `T` of the program's own. The
 * semantics checks the data against `schema` first, so `read` sees only data
 * that fits it, and is left what the schema does not say.
 */
export interface Reading<D, T> {
  readonly schema: Schema<D>;
  /**
   * Throws when the data does not read as a `T`. A reading that follows a
   * link in the data looks the blob up in `blobs`.
   */
  read(data: Fields<D>, object: { readonly bytes: Bytes<T>; readonly link: Link<T> }, blobs: Blobs): T;
}

/**
 * How a semantics writes values of `V`: as objects of `schema`, with the
 * data that `write` gives for a value. A semantics reads objects of every
 * schema it has a reading of, and writes to one of them, the one the program
 * writes now.
 */
export interface Writing<D, V> {
  readonly schema: Link<Schema<D>>;
  write(value: V): Fields<D>;
}

/**
 * Reads objects as `T`, each by the reading of the schema it is written to,
 * and refuses objects written to any other or whose data does not fit their
 * schema; with a writing, it also writes values of `V` as objects. The
 * readings and the writing are where objects become values of the program
 * and values become objects, and the only places that know the shape of the
 * data: an object written to an older schema, or to another application's,
 * reads as a `T` once there is a reading of that schema.
 */
export interface Semantics<T, V = never> {
  /**
   * Reads an object. `blobs` holds the blobs that its reading follows links
   * to, and a reading that follows one not given there fails.
   */
  decode(bytes: Bytes<T>, blobs?: Blobs): T;
  /**
   * Reads the object that `link` names, from `blobs`. A blob given for the
   * link that has another link is refused, as a wrong blob from a store
   * would be.
   */
  follow(link: Link<T>, blobs: Blobs): T;
  /**
   * Writes `value` as an object by the writing, and reads the object as
   * `decode` would, so a value that would not read is refused. `blobs` holds
   * the blobs that its reading follows links to.
   */
  encode(value: V, blobs?: Blobs): T;
}

class SemanticsOf<D, T, V> implements Semantics<T, V> {
  readonly #encoding: Encoding<D>;
  readonly #readings: ReadonlyMap<Link<Schema<D>>, Reading<D, T>>;
  readonly #writing: Writing<D, V> | undefined;

  constructor(readings: Iterable<Reading<D, T>>, writing?: Writing<D, V>) {
    let encoding: Encoding<D> | undefined;
    const bySchema = new Map<Link<Schema<D>>, Reading<D, T>>();
    for (const reading of readings) {
      if (bySchema.has(reading.schema.link)) throw new Error(`two readings of ${reading.schema.link}`);
      encoding ??= reading.schema.encoding;
      if (reading.schema.encoding !== encoding) throw new Error("the schemas a semantics reads are of more than one encoding");
      bySchema.set(reading.schema.link, reading);
    }
    if (encoding === undefined) throw new Error("a semantics reads at least one schema");
    if (writing !== undefined && !bySchema.has(writing.schema)) {
      throw new Error(`the semantics writes to ${writing.schema}, which it does not read`);
    }
    this.#encoding = encoding;
    this.#readings = bySchema;
    this.#writing = writing;
  }

  decode(bytes: Bytes<T>, blobs: Blobs = noBlobs): T {
    return this.#read(decodeBlob(this.#encoding, bytes), blobs);
  }

  follow(link: Link<T>, blobs: Blobs): T {
    const bytes = blobs.get(link);
    if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
    const decoded = decodeBlob(this.#encoding, bytes);
    if (decoded.link !== link) throw new Error(`the blob given for ${link} is another blob`);
    return this.#read(decoded, blobs);
  }

  encode(value: V, blobs: Blobs = noBlobs): T {
    if (this.#writing === undefined) throw new Error("the semantics writes nothing");
    const data = this.#writing.write(value);
    return this.decode(this.#encoding.encode(this.#encoding.object(data, this.#writing.schema)), blobs);
  }

  #read({ value, bytes, link }: Decoded<D>, blobs: Blobs): T {
    const { data, schema } = this.#encoding.fields(value);
    const reading = this.#readings.get(schema);
    if (reading === undefined) throw new Error(`the object is written to ${schema}, which is not read here`);
    return reading.read(reading.schema.validate(data), { bytes, link }, blobs);
  }
}

/**
 * Makes a semantics of its readings and its writing, whose schemas all have
 * one encoding, the same `Encoding` object. `D`, the data of that encoding,
 * ties the readings and the writing together while the semantics is made,
 * and is not part of its type: a program holds a `Semantics<T, V>`, whatever
 * the encoding.
 */
export const Semantics: new <D, T, V = never>(readings: Iterable<Reading<D, T>>, writing?: Writing<D, V>) => Semantics<T, V> = SemanticsOf;
