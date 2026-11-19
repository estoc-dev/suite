import { type Implementations, type Link, type Reader, type Selection, schemaOf } from "@estoc/object";
import type { Lineage } from "./lineage.ts";

/**
 * A schema does not say which version it follows. The lineage says it, with no more authority than
 * any other: the same versions in the same order give the same head.
 */
export class SchemaLineage<T> {
  readonly lineage: Lineage;
  readonly blobs: readonly Uint8Array[];
  readonly selection: SelectionBySchemaLineage<T, T>;
  readonly #implementations: Implementations<T>;

  constructor(lineage: Lineage, schemaBlobs: readonly Uint8Array[], implementations: Implementations<T>) {
    this.lineage = lineage;
    this.blobs = [...lineage.blobs, ...schemaBlobs];
    this.#implementations = implementations;
    this.selection = new SelectionBySchemaLineage(this, (shape) => shape);
  }

  read(link: Link<unknown>, reader: Reader): Promise<T> {
    return this.#implementations.read(link, reader);
  }

  hasSchemaNamedBy(bytes: Uint8Array): boolean {
    return this.lineage.items.includes(schemaOf(bytes));
  }
}

export class SelectionBySchemaLineage<T, V> implements Selection<T> {
  readonly schemaLineage: SchemaLineage<V>;
  readonly #itemOf: (shape: V, reader: Reader) => T | undefined | Promise<T | undefined>;

  constructor(
    schemaLineage: SchemaLineage<V>,
    itemOf: (shape: V, reader: Reader) => T | undefined | Promise<T | undefined>,
  ) {
    this.schemaLineage = schemaLineage;
    this.#itemOf = itemOf;
  }

  async read(record: Link<unknown>, reader: Reader): Promise<T | undefined> {
    const bytes = await reader.get(record);
    // A record the reader does not give is left to `read`, which refuses it.
    if (bytes !== undefined && !this.schemaLineage.hasSchemaNamedBy(bytes)) return undefined;
    return this.#itemOf(await this.schemaLineage.read(record, reader), reader);
  }
}
