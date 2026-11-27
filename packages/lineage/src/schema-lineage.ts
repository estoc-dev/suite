import { type Implementations, type Link, type Reader, schemaOf } from "@estoc/object";
import type { Lineage } from "./lineage.ts";

/**
 * A schema does not say which version it follows. The lineage says it, with no more authority than
 * any other: the same versions in the same order give the same head.
 */
export class SchemaLineage<T> {
  readonly lineage: Lineage;
  readonly blobs: readonly Uint8Array[];
  readonly #implementations: Implementations<T>;

  constructor(lineage: Lineage, schemaBlobs: readonly Uint8Array[], implementations: Implementations<T>) {
    this.lineage = lineage;
    this.blobs = [...lineage.blobs, ...schemaBlobs];
    this.#implementations = implementations;
  }

  read(link: Link<unknown>, reader: Reader): Promise<T> {
    return this.#implementations.read(link, reader);
  }

  hasSchemaNamedBy(bytes: Uint8Array): boolean {
    return this.lineage.items.includes(schemaOf(bytes));
  }
}
