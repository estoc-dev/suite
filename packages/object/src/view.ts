import { decodeJson, encodeJson, isJsonObject, isLink, type Bytes, type Decoded, type Json, type Link } from "./encoding.ts";
import type { Schema } from "./schema.ts";

/** Blobs by their links: a Map, a bundle, or a store that holds blobs by content. */
export interface Blobs {
  get(link: Link<unknown>): Uint8Array | undefined;
}

const noBlobs: Blobs = { get: () => undefined };

/**
 * One way of reading the objects written to one schema: their data, and the
 * bytes and link of the object, become a `T` of the program's own.
 */
export interface Reading<T> {
  readonly schema: Link<Schema>;
  /**
   * Throws when the data does not read as a `T`. A reading that follows a
   * link in the data looks the blob up in `blobs`.
   */
  read(data: Json, object: { readonly bytes: Bytes<T>; readonly link: Link<T> }, blobs: Blobs): T;
}

/**
 * Reads objects as `T`, each by the reading of the schema it is written to,
 * and refuses objects written to any other. The readings are where an object
 * from outside becomes a value of the program, and the only place that knows
 * the shape of its data: an object written to an older schema, or to another
 * application's, reads as a `T` once there is a reading of that schema.
 */
export class View<T> {
  readonly #readings: ReadonlyMap<Link<Schema>, Reading<T>>;

  constructor(readings: Iterable<Reading<T>>) {
    const bySchema = new Map<Link<Schema>, Reading<T>>();
    for (const reading of readings) {
      if (bySchema.has(reading.schema)) throw new Error(`two readings of ${reading.schema}`);
      bySchema.set(reading.schema, reading);
    }
    this.#readings = bySchema;
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

  /** Writes `data` to `schema` as an object, and reads it as `decode` would. */
  encode(schema: Link<Schema>, data: Json, blobs: Blobs = noBlobs): T {
    return this.decode(encodeJson({ data, schema }), blobs);
  }

  #read({ value, bytes, link }: Decoded, blobs: Blobs): T {
    const { data, schema } = fieldsOf(value);
    if (!isLink(schema)) throw new Error("an object names its schema by link");
    const reading = this.#readings.get(schema);
    if (reading === undefined) throw new Error(`the object is written to ${schema}, which is not read here`);
    return reading.read(data, { bytes, link }, blobs);
  }
}

/** A reading that refuses data that does not fit `schema` before `read` sees it. */
export function reading<T>(schema: Schema, read: Reading<T>["read"]): Reading<T> {
  return {
    schema: schema.link,
    read(data, object, blobs) {
      const problems = schema.validate(data);
      if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
      return read(data, object, blobs);
    },
  };
}

export function fieldsOf(value: Json): { readonly data: Json; readonly schema: Json } {
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
    throw new Error("an object has the fields data and schema");
  }
  return value as { data: Json; schema: Json };
}
