import type { Encoding, Fields } from "./encoding.ts";
import type { Link } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { Schema } from "./schema.ts";

/**
 * A concrete schema that a program reads as an interface, with how an
 * object written to it becomes the interface's shape `T`.
 */
export interface Implementation<D, T, F extends Fields<D> = Fields<D>> {
  readonly schema: Schema<D, F>;
  /** Takes an object already read with `schema`, and reads what it links to from `reader`. */
  read(object: EncodedObject<D, F>, reader: Reader): T | Promise<T>;
}

/**
 * The concrete schemas a program reads as one interface, each with its
 * implementation, picked by the schema an object names. Which schemas these
 * are is the program's to say, and an object of any other is refused.
 */
export class Implementations<D, T, I extends Implementation<D, T> = Implementation<D, T>> {
  readonly #encoding: Encoding<D>;
  readonly #implementations: ReadonlyMap<Link<Schema<D>>, I>;

  // Naming `T` beside `I` lets it be inferred from the implementations rather than left unknown.
  /** `encoding` is that of the schemas, in which an object names its schema. */
  constructor(encoding: Encoding<D>, implementations: Iterable<I & Implementation<D, T>>) {
    const byLink = new Map<Link<Schema<D>>, I>();
    for (const implementation of implementations) {
      const { link } = implementation.schema;
      if (byLink.has(link)) throw new Error(`${link} is given two implementations`);
      byLink.set(link, implementation);
    }
    this.#encoding = encoding;
    this.#implementations = byLink;
  }

  /**
   * The implementation of `schema`, for what a program does with objects of
   * it beyond reading them.
   *
   * @throws when `schema` is not one of these.
   */
  implementationOf(schema: Link<Schema<D>>): I {
    const implementation = this.#implementations.get(schema);
    if (implementation === undefined) throw new Error(`${schema} is not a schema read here`);
    return implementation;
  }

  /** Reads the object that `link` names from `reader` with the implementation of the schema it names. */
  async read(link: Link<T>, reader: Reader): Promise<T> {
    const bytes = await readBlob(reader, link);
    const implementation = this.implementationOf(schemaOf(bytes, this.#encoding));
    return implementation.read(decodeObjectAt(link, bytes, implementation.schema), reader);
  }
}
