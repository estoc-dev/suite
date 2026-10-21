import { decodeJson, encodeJson, isJsonObject, isLink, type Bytes, type Json, type Link } from "./encoding.ts";
import type { Schema } from "./schema.ts";

/**
 * One way of reading the objects written to one schema: their data, and the
 * bytes and link of the object, become a `T` of the program's own.
 */
export interface Reading<T> {
  readonly schema: Link<Schema>;
  /** Throws when the data does not read as a `T`. */
  read(data: Json, object: { readonly bytes: Bytes<T>; readonly link: Link<T> }): T;
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

  decode(bytes: Bytes<T>): T {
    const decoded = decodeJson(bytes);
    const { data, schema } = fieldsOf(decoded.value);
    if (!isLink(schema)) throw new Error("an object names its schema by link");
    const reading = this.#readings.get(schema);
    if (reading === undefined) throw new Error(`the object is written to ${schema}, which is not read here`);
    return reading.read(data, { bytes: decoded.bytes, link: decoded.link });
  }

  /** Writes `data` to `schema` as an object, and reads it as `decode` would. */
  encode(schema: Link<Schema>, data: Json): T {
    return this.decode(encodeJson({ data, schema }));
  }
}

/** A reading that refuses data that does not fit `schema` before `read` sees it. */
export function reading<T>(schema: Schema, read: Reading<T>["read"]): Reading<T> {
  return {
    schema: schema.link,
    read(data, object) {
      const problems = schema.validate(data);
      if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
      return read(data, object);
    },
  };
}

export function fieldsOf(value: Json): { readonly data: Json; readonly schema: Json } {
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
    throw new Error("an object has the fields data and schema");
  }
  return value as { data: Json; schema: Json };
}
