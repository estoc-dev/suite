import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Encoding, Fields } from "./encoding.ts";
import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { Schema } from "./schema.ts";

/**
 * What the objects of a schema read as, whichever of several schemas they
 * are written to: a blob that each such schema names by link, in JSON
 * Schema by `x-implements`. The interface is in the closure of each such
 * schema, so whoever holds the schema can get the interface too.
 */
export interface Interface {
  readonly bytes: Bytes<Interface>;
  readonly link: Link<Interface>;
}

/** An interface that is its name in UTF-8. */
export function interfaceNamed(name: string): Interface {
  const bytes: Bytes<Interface> = utf8ToBytes(name);
  return { bytes, link: linkOf(bytes) };
}

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
 * implementation, picked by the schema an object names.
 *
 * - Which schemas these are is the program's to say; one that a schema names as its interface but
 *   the program does not list is refused like any other.
 * - The schemas are closed under following: each schema that one of them follows is one of them
 *   too, so a program that reads a version of a format reads the versions before it.
 */
export class Implementations<D, T, I extends Implementation<D, T> = Implementation<D, T>> {
  readonly #encoding: Encoding<D>;
  readonly #implementations: ReadonlyMap<Link<Schema<D>>, I>;

  // Naming `T` beside `I` lets it be inferred from the implementations rather than left unknown.
  /**
   * `encoding` is that of the schemas, in which an object names its schema.
   *
   * @throws when two implementations are of one schema, or when a schema follows one that is not
   * among them.
   */
  constructor(encoding: Encoding<D>, implementations: Iterable<I & Implementation<D, T>>) {
    const byLink = new Map<Link<Schema<D>>, I>();
    for (const implementation of implementations) {
      const { link } = implementation.schema;
      if (byLink.has(link)) throw new Error(`${link} is given two implementations`);
      byLink.set(link, implementation);
    }
    for (const { schema } of byLink.values()) {
      const { predecessor } = schema;
      if (predecessor !== undefined && !byLink.has(predecessor))
        throw new Error(`${schema.link} follows ${predecessor}, which is not read here`);
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
