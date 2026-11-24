import type { Schema, ValueMap } from "@estoc/object";
import { type FieldNames, type NamedIndex, type Store, scan } from "@estoc/store";
import type { Page } from "./calls.ts";

/** It is bound to no store: whoever reads a page says which store the page is of. */
export interface List {
  readonly name: string;
  readonly rowSchema: Schema;
  readonly order: readonly string[];
  readonly readsBlobs: boolean;
  page(store: Store, start: number, limit: number): Promise<Page>;
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
    async page(store, start, limit) {
      // What the index fails on gives no row, and the rows of the rest are shown without it.
      const sortedRows = await scan(store, index, { throwsOnFailure: false });
      const rows: Uint8Array[] = [];
      for await (const { bytes } of sortedRows.range([])) rows.push(bytes);
      const page = pageIn(rows, start, limit);
      return { start: page.start, rowCount: rows.length, blobCount: sortedRows.blobCount, rows: page.rows };
    },
  };
}
