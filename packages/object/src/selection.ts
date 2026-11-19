import type { Link } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { ValueMap } from "./object-format.ts";
import type { Schema } from "./schema.ts";

/**
 * What a selection takes, and what each reads as, depend on the record and its closure alone, so it
 * takes the same records whatever else the program has read.
 */
export interface Selection<T> {
  read(record: Link<unknown>, reader: Reader): T | undefined | Promise<T | undefined>;
}

export class SelectionBySchema<T, F extends ValueMap = ValueMap> implements Selection<T> {
  readonly schema: Schema<F>;
  readonly #itemOf: (object: EncodedObject<F>, reader: Reader) => T | undefined | Promise<T | undefined>;

  constructor(
    schema: Schema<F>,
    itemOf: (object: EncodedObject<F>, reader: Reader) => T | undefined | Promise<T | undefined>,
  ) {
    this.schema = schema;
    this.#itemOf = itemOf;
  }

  itemOf(object: EncodedObject<F>, reader: Reader): T | undefined | Promise<T | undefined> {
    return this.#itemOf(object, reader);
  }

  async read(record: Link<unknown>, reader: Reader): Promise<T | undefined> {
    const bytes = await readBlob(reader, record);
    if (schemaOf(bytes) !== this.schema.link) return undefined;
    return this.itemOf(decodeObjectAt(record, bytes, this.schema), reader);
  }
}

export function objectsOf<F extends ValueMap>(schema: Schema<F>): SelectionBySchema<EncodedObject<F>, F> {
  return new SelectionBySchema(schema, (object) => object);
}
