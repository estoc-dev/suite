import type { Fields } from "./encoding.ts";
import type { EncodedObject, Reader } from "./object.ts";
import type { Schema } from "./schema.ts";

/**
 * Which objects of a schema a program takes, and what each one it takes
 * reads as. Both depend on the object and its closure alone, so a selection
 * takes the same objects whatever else the program has read.
 */
export interface Selection<D, T, F extends Fields<D> = Fields<D>> {
  readonly schema: Schema<D, F>;
  /**
   * Takes an object already read with `schema`, and reads what it links to
   * from `reader`. Gives `undefined` for an object the selection leaves out.
   */
  read(object: EncodedObject<D, F>, reader: Reader): T | undefined | Promise<T | undefined>;
}

/** The selection of every object of `schema`, each read as itself. */
export function objectsOf<D, F extends Fields<D>>(schema: Schema<D, F>): Selection<D, EncodedObject<D, F>, F> {
  return { schema, read: (object) => object };
}
