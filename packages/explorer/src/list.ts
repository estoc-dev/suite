import type { Schema, Value, ValueMap } from "@estoc/object";
import type { FieldNames, KeyOf, NamedIndex, Prefix, Store } from "@estoc/store";
import type { Page } from "./calls.ts";

/**
 * It is bound to no store: whoever reads a page says which store the page is of. The page is of the
 * rows under `prefix`, and `start` counts those alone.
 */
export interface List {
  readonly name: string;
  readonly rowSchema: Schema;
  readonly order: readonly string[];
  readonly readsBlobs: boolean;
  page(store: Store, prefix: readonly Value[], start: number, limit: number): Promise<Page>;
}

export function pageIn<T>(rows: readonly T[], start: number, limit: number): { start: number; rows: T[] } {
  const first = start < 0 ? Math.max(rows.length + start, 0) : Math.min(start, rows.length);
  return { start: first, rows: rows.slice(first, first + Math.max(limit, 0)) };
}

export function listOfIndex<F extends ValueMap, By extends FieldNames<F>>(index: NamedIndex<F, By>): List {
  return {
    name: index.name,
    rowSchema: index.rowSchema,
    order: index.order,
    readsBlobs: index.readsBlobs,
    async page(store, prefix, start, limit) {
      // What the index fails on gives no row, and the rows of the rest are shown without it.
      const sortedRows = await store.scan(index, { throwsOnFailure: false });
      const rows: Uint8Array[] = [];
      // The values are whatever the caller of the runtime gave. Those that are not of the types of
      // the fields are the key of no row.
      for await (const { bytes } of sortedRows.range(prefix as Prefix<KeyOf<F, By>>)) rows.push(bytes);
      const page = pageIn(rows, start, limit);
      return { start: page.start, rowCount: rows.length, blobCount: sortedRows.blobCount, rows: page.rows };
    },
  };
}
