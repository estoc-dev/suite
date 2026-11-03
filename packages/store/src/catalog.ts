import { type Encoding, type Link, type Schema, schemaOf } from "@estoc/object";
import { type Rows, rowsOf } from "./scan.ts";
import type { Store } from "./store.ts";

/** A row of a catalog: the link of the schema an object names, and the link of the object. */
export type CatalogEntry<D> = readonly [schema: Link<Schema<D>>, object: Link<never>];

/**
 * What was written to `store` as mine, by the schema each object names: a
 * row `[schema, object]` for each, so that `range([schema])` gives the
 * objects written to that schema, in the order of their links, and
 * `range([])` gives every schema that something written as mine names. The
 * store may be a `PrivateStore` or a `Staged`.
 *
 * The schema is read with `schemaOf`, given `encoding`, the encoding of the
 * store, and the object is not checked against it: an object is listed by
 * what it names and not read as it, so that a viewer of arbitrary objects
 * lists them without compiling schemas someone else wrote. Reading an object
 * with its schema is what checks it. As with an index, only what the store
 * lists as mine is in the catalog, and what came from elsewhere is reached
 * by following links from it.
 */
export async function catalog<D>(
  store: Pick<Store, "get" | "mine">,
  encoding: Encoding<D>,
): Promise<Rows<CatalogEntry<D>>> {
  const entries: CatalogEntry<D>[] = [];
  for await (const link of store.mine()) {
    const bytes = await store.get(link);
    if (bytes === undefined) throw new Error(`the store lists ${link} but does not hold it`);
    entries.push([schemaOf(bytes, encoding), link]);
  }
  return rowsOf(entries);
}
