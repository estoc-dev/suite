import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Fields } from "./encoding.ts";
import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { Schema, SchemaLanguage } from "./schema.ts";

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
  readonly #language: SchemaLanguage<unknown, D>;
  readonly #implementations: ReadonlyMap<Link<Schema<D>>, I>;

  // Naming `T` beside `I` lets it be inferred from the implementations rather than left unknown.
  /**
   * `language` is that of the schemas: an object names its schema in its encoding, and a schema
   * that is not one of these is read in it for the schemas it follows.
   *
   * @throws when two implementations are of one schema, or when a schema follows one that is not
   * among them.
   */
  constructor(language: SchemaLanguage<unknown, D>, implementations: Iterable<I & Implementation<D, T>>) {
    const byLink = new Map<Link<Schema<D>>, I>();
    for (const implementation of implementations) {
      const { link } = implementation.schema;
      if (byLink.has(link)) throw new Error(`${link} is given two implementations`);
      byLink.set(link, implementation);
    }
    for (const { schema } of byLink.values()) {
      for (const predecessor of schema.predecessors) {
        if (!byLink.has(predecessor)) throw new Error(`${schema.link} follows ${predecessor}, which is not read here`);
      }
    }
    this.#language = language;
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

  /**
   * Reads the object that `link` names from `reader` with the implementation of the schema it names.
   *
   * @throws {NewerSchema} when the object's schema is not one of these but follows one of them,
   * directly or through schemas that `reader` gives.
   * @throws when the object's schema is not one of these and is not found to follow one.
   */
  async read(link: Link<T>, reader: Reader): Promise<T> {
    const bytes = await readBlob(reader, link);
    const schema = schemaOf(bytes, this.#language.encoding);
    const implementation = this.#implementations.get(schema);
    if (implementation === undefined) throw await this.#refusalOf(schema, reader);
    return implementation.read(decodeObjectAt(link, bytes, implementation.schema), reader);
  }

  async #refusalOf(schema: Link<Schema<D>>, reader: Reader): Promise<Error> {
    const seen = new Set([schema]);
    const unread = [schema];
    for (let next = unread.shift(); next !== undefined; next = unread.shift()) {
      for (const predecessor of await this.#predecessorsOf(next, reader)) {
        if (this.#implementations.has(predecessor)) return new NewerSchema(schema, predecessor);
        if (!seen.has(predecessor)) {
          seen.add(predecessor);
          unread.push(predecessor);
        }
      }
    }
    return new Error(`${schema} is not a schema read here`);
  }

  // The walk only picks which error to give, so a schema the reader does not give, or bytes that
  // do not read as a schema, end a path rather than the read.
  async #predecessorsOf(schema: Link<Schema<D>>, reader: Reader): Promise<readonly Link<Schema<D>>[]> {
    const bytes = await reader.get(schema);
    if (bytes === undefined) return [];
    try {
      return this.#language.predecessorsOf(this.#language.decode(bytes));
    } catch {
      return [];
    }
  }
}

/**
 * An object written to a schema that a program does not read but that
 * follows one it does: a newer version of a format the program reads, which
 * a newer version of the program may read.
 */
export class NewerSchema<D = unknown> extends Error {
  override readonly name = "NewerSchema";
  /** The schema the object is written to. */
  readonly schema: Link<Schema<D>>;
  /** A schema read here that `schema` follows, directly or through others. */
  readonly predecessor: Link<Schema<D>>;

  constructor(schema: Link<Schema<D>>, predecessor: Link<Schema<D>>) {
    super(`${schema} is not a schema read here, but follows ${predecessor}, which is`);
    this.schema = schema;
    this.predecessor = predecessor;
  }
}
