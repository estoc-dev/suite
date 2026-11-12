import type { Implementations, Link, Reader, Selection } from "@estoc/object";
import type { Lineage } from "./lineage.ts";

/**
 * The versions of a format as the lineage of their schemas, each read as
 * `T` by its implementation.
 *
 * - A schema says what its data looks like and not which version it
 *   follows. The lineage says it, with no more authority than any other:
 *   the same versions in the same order give the same head.
 * - An object is read with the version whose schema it names, so objects
 *   of earlier versions stay as they were written.
 */
export class SchemaLineage<T> {
  /** The lineage whose items are the schemas of the versions, in their order. */
  readonly lineage: Lineage;
  /** The closure of the lineage's head: its `blobs` and the closure of every version's schema. */
  readonly blobs: readonly Uint8Array[];
  /** The selection of every object of a version, each read as `T`. */
  readonly selection: SelectionBySchemaLineage<T, T>;
  readonly #implementations: Pick<Implementations<unknown, T>, "read">;
  readonly #schemaOf: (record: Uint8Array) => Link<unknown>;

  /**
   * `lineage` is that of the schemas of the versions, and `schemaBlobs` the
   * closures of those schemas. `implementations` reads with the versions and
   * `schemaOf` gives the schema a record of their encoding names, so the
   * encoding stays in them and a schema lineage carries `T` alone.
   */
  constructor(
    lineage: Lineage,
    schemaBlobs: readonly Uint8Array[],
    implementations: Pick<Implementations<unknown, T>, "read">,
    schemaOf: (record: Uint8Array) => Link<unknown>,
  ) {
    this.lineage = lineage;
    this.blobs = [...lineage.blobs, ...schemaBlobs];
    this.#implementations = implementations;
    this.#schemaOf = schemaOf;
    this.selection = new SelectionBySchemaLineage(this, (shape) => shape);
  }

  /**
   * Reads the object that `link` names from `reader` with the version of the schema it names.
   *
   * @throws when the object is of the schema of no version, and where `Implementations.read` throws.
   */
  read(link: Link<T>, reader: Reader): Promise<T> {
    return this.#implementations.read(link, reader);
  }

  /**
   * Whether the object that `bytes` hold names the schema of a version.
   *
   * @throws when the bytes are not an object in the encoding of the versions.
   */
  hasSchemaNamedBy(bytes: Uint8Array): boolean {
    return this.lineage.items.includes(this.#schemaOf(bytes));
  }
}

/**
 * A selection of objects of the versions of a schema lineage, which works
 * out what each reads as from what its version reads it as.
 *
 * - A record of any other schema is left out.
 * - It reads each record itself, as any selection other than by schema
 *   does, so a record that it and a selection by the schema of one version
 *   both take is validated by each.
 */
export class SelectionBySchemaLineage<T, V> implements Selection<T> {
  readonly schemaLineage: SchemaLineage<V>;
  readonly #itemOf: (shape: V, reader: Reader) => T | undefined | Promise<T | undefined>;

  /** `itemOf` gives what an object read as `V` reads as, or `undefined` for one the selection leaves out. */
  constructor(
    schemaLineage: SchemaLineage<V>,
    itemOf: (shape: V, reader: Reader) => T | undefined | Promise<T | undefined>,
  ) {
    this.schemaLineage = schemaLineage;
    this.#itemOf = itemOf;
  }

  /**
   * Gives `undefined` for a record of the schema of no version.
   *
   * @throws when the reader gives no blob for the record, and where the schema lineage's `read`
   *   throws for an object of a version.
   */
  async read(record: Link<unknown>, reader: Reader): Promise<T | undefined> {
    const bytes = await reader.get(record);
    // A record the reader does not give is left to `read`, which refuses it.
    if (bytes !== undefined && !this.schemaLineage.hasSchemaNamedBy(bytes)) return undefined;
    return this.#itemOf(await this.schemaLineage.read(record as Link<V>, reader), reader);
  }
}
