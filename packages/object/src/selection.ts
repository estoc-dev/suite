import type { Fields } from "./encoding.ts";
import type { Link } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { Schema } from "./schema.ts";

/**
 * Which records a program takes, and what each one it takes reads as. Both
 * depend on the record and its closure alone, so a selection takes the same
 * records whatever else the program has read.
 */
export interface Selection<T> {
  /**
   * Reads the record that `record` names, and what it links to, from
   * `reader`. Gives `undefined` for a record the selection leaves out.
   */
  read(record: Link<unknown>, reader: Reader): T | undefined | Promise<T | undefined>;
}

/**
 * The selection of every object of `schema`, each read as itself.
 *
 * @throws when the reader gives no blob for the record, and where `decodeObject` throws for an
 * object of `schema`.
 */
export function objectsOf<D, F extends Fields<D>>(schema: Schema<D, F>): Selection<EncodedObject<D, F>> {
  return {
    async read(record, reader) {
      const bytes = await readBlob(reader, record);
      return schemaOf(bytes, schema.encoding) === schema.link ? decodeObjectAt(record, bytes, schema) : undefined;
    },
  };
}
