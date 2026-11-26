import type { Schema, ValueMap } from "@estoc/object";
import type { FieldNames, Index, Store } from "@estoc/store";
import type { Page } from "./calls.ts";

/** It is bound to no store: whoever reads a page says which store the page is of. */
export interface List {
  readonly name: string;
  readonly rowSchema: Schema;
  readonly order: readonly string[];
  page(store: Store, start: number, limit: number): Promise<Page>;
}

export function pageIn<T>(rows: readonly T[], start: number, limit: number): { start: number; rows: T[] } {
  const first = start < 0 ? Math.max(rows.length + start, 0) : Math.min(start, rows.length);
  return { start: first, rows: rows.slice(first, first + Math.max(limit, 0)) };
}

export function listOfIndex<F extends ValueMap, const By extends FieldNames<F>>(
  index: Index<F>,
  name: string,
  order: By,
): List {
  return {
    name,
    rowSchema: index.rowSchema,
    order,
    async page(store, start, limit) {
      const scannedRows = await store.scan(index);
      const rows: Uint8Array[] = [];
      for await (const { bytes } of scannedRows.orderedBy(...order).range([])) rows.push(bytes);
      const page = pageIn(rows, start, limit);
      return { start: page.start, rowCount: rows.length, blobCount: scannedRows.blobCount, rows: page.rows };
    },
  };
}
