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
 * A selection of objects of one schema, which works out what each reads as
 * from the object read with that schema. Reading a record with it comes to
 * reading the object first, so what reads records with several selections
 * may read each record with a schema once, and pass over records of other
 * schemas.
 */
export class ObjectSelection<D, T, F extends Fields<D> = Fields<D>> implements Selection<T> {
  readonly schema: Schema<D, F>;
  readonly #itemOf: (object: EncodedObject<D, F>, reader: Reader) => T | undefined | Promise<T | undefined>;

  /** `itemOf` gives what an object read with `schema` reads as, or `undefined` for one the selection leaves out. */
  constructor(
    schema: Schema<D, F>,
    itemOf: (object: EncodedObject<D, F>, reader: Reader) => T | undefined | Promise<T | undefined>,
  ) {
    this.schema = schema;
    this.#itemOf = itemOf;
  }

  /**
   * What `object`, already read with `schema`, reads as, reading what it
   * links to from `reader`. Gives `undefined` for an object the selection
   * leaves out.
   */
  itemOf(object: EncodedObject<D, F>, reader: Reader): T | undefined | Promise<T | undefined> {
    return this.#itemOf(object, reader);
  }

  /**
   * Gives `undefined` for a record of another schema.
   *
   * @throws when the reader gives no blob for the record, and where `decodeObject` throws for an
   * object of `schema`.
   */
  async read(record: Link<unknown>, reader: Reader): Promise<T | undefined> {
    const bytes = await readBlob(reader, record);
    if (schemaOf(bytes, this.schema.encoding) !== this.schema.link) return undefined;
    return this.itemOf(decodeObjectAt(record, bytes, this.schema), reader);
  }
}

/** The selection of every object of `schema`, each read as itself. */
export function objectsOf<D, F extends Fields<D>>(schema: Schema<D, F>): ObjectSelection<D, EncodedObject<D, F>, F> {
  return new ObjectSelection(schema, (object) => object);
}
