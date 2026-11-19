import type { Link } from "./link.ts";
import { decodeObjectAt, type EncodedObject, type Reader, readBlob, schemaOf } from "./object.ts";
import type { ValueMap } from "./object-format.ts";
import type { Schema } from "./schema.ts";

export interface Implementation<T, F extends ValueMap = ValueMap> {
  readonly schema: Schema<F>;
  read(object: EncodedObject<F>, reader: Reader): T | Promise<T>;
}

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

  implementationOf(schema: Link<Schema>): I | undefined {
    return this.#implementations.get(schema);
  }

  async read(link: Link<unknown>, reader: Reader): Promise<T> {
    const bytes = await readBlob(reader, link);
    const schema = schemaOf(bytes);
    const implementation = this.implementationOf(schema);
    if (implementation === undefined) throw new Error(`${schema} is not a schema read here`);
    return implementation.read(decodeObjectAt(link, bytes, implementation.schema), reader);
  }
}
