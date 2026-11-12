import type { Link } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { ValueMap } from "./object-format.ts";
import type { Schema } from "./schema.ts";

/**
 * A concrete schema that a program reads as an interface, with how an
 * object written to it becomes the interface's shape `T`.
 */
export interface Implementation<T, F extends ValueMap = ValueMap> {
  readonly schema: Schema<F>;
  /** Takes an object already read with `schema`, and reads what it links to from `reader`. */
  read(object: EncodedObject<F>, reader: Reader): T | Promise<T>;
}

/**
 * The concrete schemas a program reads as one interface, each with its
 * implementation, picked by the schema an object names. Which schemas these
 * are is the program's to say, and an object of any other is refused.
 */
export class Implementations<T, I extends Implementation<T> = Implementation<T>> {
  readonly #implementations: ReadonlyMap<Link<Schema>, I>;

  // Naming `T` beside `I` lets it be inferred from the implementations rather than left unknown.
  constructor(implementations: Iterable<I & Implementation<T>>) {
    const byLink = new Map<Link<Schema>, I>();
    for (const implementation of implementations) {
      const { link } = implementation.schema;
      if (byLink.has(link)) throw new Error(`${link} is given two implementations`);
      byLink.set(link, implementation);
    }
    this.#implementations = byLink;
  }

  /**
   * The implementation of `schema`, for what a program does with objects of
   * it beyond reading them.
   *
   * @throws when `schema` is not one of these.
   */
  implementationOf(schema: Link<Schema>): I {
    const implementation = this.#implementations.get(schema);
    if (implementation === undefined) throw new Error(`${schema} is not a schema read here`);
    return implementation;
  }

  /** Reads the object that `link` names from `reader` with the implementation of the schema it names. */
  async read(link: Link<T>, reader: Reader): Promise<T> {
    const bytes = await readBlob(reader, link);
    const implementation = this.implementationOf(schemaOf(bytes));
    return implementation.read(decodeObjectAt(link, bytes, implementation.schema), reader);
  }
}
