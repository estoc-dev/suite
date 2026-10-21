import { decodeJson, encodeJson, isJsonObject, isLink, type Bytes, type Decoded, type Json, type Link } from "./encoding.ts";
import type { Schema } from "./schema.ts";

/** Blobs by their links: a Map, a bundle, or a store that holds blobs by content. */
export interface Blobs {
  get(link: Link<unknown>): Uint8Array | undefined;
}

const noBlobs: Blobs = { get: () => undefined };

/**
 * One way of reading the objects written to one schema: their data, and the
 * bytes and link of the object, become a `T` of the program's own. The view
 * checks the data against `schema` first, so `read` sees only data that fits
 * it, and is left what the schema does not say.
 */
export interface Reading<T> {
  readonly schema: Schema;
  /**
   * Throws when the data does not read as a `T`. A reading that follows a
   * link in the data looks the blob up in `blobs`.
   */
  read(data: Json, object: { readonly bytes: Bytes<T>; readonly link: Link<T> }, blobs: Blobs): T;
}

/**
 * How a view writes values of `V`: as objects of `schema`, with the data that
 * `write` gives for a value. A view reads objects of every schema it has a
 * reading of, and writes to one of them, the one the program writes now.
 */
export interface Writing<V> {
  readonly schema: Link<Schema>;
  write(value: V): Json;
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
export class View<T, V = never> {
  readonly #readings: ReadonlyMap<Link<Schema>, Reading<T>>;
  readonly #writing: Writing<V> | undefined;

  constructor(readings: Iterable<Reading<T>>, writing?: Writing<V>) {
    const bySchema = new Map<Link<Schema>, Reading<T>>();
    for (const reading of readings) {
      if (bySchema.has(reading.schema.link)) throw new Error(`two readings of ${reading.schema.link}`);
      bySchema.set(reading.schema.link, reading);
    }
    if (writing !== undefined && !bySchema.has(writing.schema)) {
      throw new Error(`the view writes to ${writing.schema}, which it does not read`);
    }
    this.#readings = bySchema;
    this.#writing = writing;
  }

  /**
   * Reads an object. `blobs` holds the blobs that its reading follows links
   * to, and a reading that follows one not given there fails.
   */
  decode(bytes: Bytes<T>, blobs: Blobs = noBlobs): T {
    return this.#read(decodeJson(bytes), blobs);
  }

  /**
   * Reads the object that `link` names, from `blobs`. A blob given for the
   * link that has another link is refused, as a wrong blob from a store
   * would be.
   */
  follow(link: Link<T>, blobs: Blobs): T {
    const bytes = blobs.get(link);
    if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
    const decoded = decodeJson(bytes);
    if (decoded.link !== link) throw new Error(`the blob given for ${link} is another blob`);
    return this.#read(decoded, blobs);
  }

  /**
   * Writes `value` as an object by the view's writing, and reads the object
   * as `decode` would, so a value that would not read is refused. `blobs`
   * holds the blobs that its reading follows links to.
   */
  encode(value: V, blobs: Blobs = noBlobs): T {
    if (this.#writing === undefined) throw new Error("the view writes nothing");
    return this.decode(encodeJson({ data: this.#writing.write(value), schema: this.#writing.schema }), blobs);
  }

  #read({ value, bytes, link }: Decoded, blobs: Blobs): T {
    const { data, schema } = fieldsOf(value);
    if (!isLink(schema)) throw new Error("an object names its schema by link");
    const reading = this.#readings.get(schema);
    if (reading === undefined) throw new Error(`the object is written to ${schema}, which is not read here`);
    const problems = reading.schema.validate(data);
    if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
    return reading.read(data, { bytes, link }, blobs);
  }
}

export function fieldsOf(value: Json): { readonly data: Json; readonly schema: Json } {
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
    throw new Error("an object has the fields data and schema");
  }
  return value as { data: Json; schema: Json };
}
