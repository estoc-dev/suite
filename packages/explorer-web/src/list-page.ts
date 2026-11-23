import type { Client, ListData } from "@estoc/explorer";
import { AbsentBlob, decodeObject, decodeSchema, type Link, type Schema, type ValueMap } from "@estoc/object";
import { type Field, rootSchema, schemaLanguage, schemaValidator } from "@estoc/schema";
import type { Place } from "./place.ts";

/** What a page reads of the runtime, which a client gives. */
export type Source = Pick<Client, "get" | "lists" | "page">;

export const pageSize = 50;

export interface Column {
  readonly name: string;
  readonly field: Field;
}

export interface RowSchema {
  readonly schema: Schema;
  readonly columns: readonly Column[];
}

export async function readRowSchema(source: Source, link: Link<Schema>): Promise<RowSchema> {
  const bytes = await source.get(link);
  if (bytes === undefined) throw new AbsentBlob(link);
  const { fields } = schemaLanguage.document(decodeObject(bytes, rootSchema).data);
  return {
    schema: decodeSchema(bytes, schemaValidator),
    columns: Object.entries(fields).map(([name, field]) => ({ name, field })),
  };
}

/**
 * - `rows` are in the order shown, and `start` is how many rows the list has before them.
 * - `previous` and `next` are the pages shown before and after this one, each left out where the
 *   list ends.
 */
export interface ListPage {
  readonly columns: readonly Column[];
  readonly rows: readonly ValueMap[];
  readonly start: number;
  readonly rowCount: number;
  readonly previous?: Place;
  readonly next?: Place;
}

/**
 * A list that keeps the order its rows were written in is shown newest first, so it is read from
 * its end. A row of it keeps its place, so the page that reads from a place stays the same page
 * while rows are written. Any other list is shown in its own order.
 */
export const isShownNewestFirst = ({ order }: ListData) => order.length === 0;

export async function readListPage(
  source: Source,
  list: ListData,
  { schema, columns }: RowSchema,
  from: number | undefined,
): Promise<ListPage> {
  const isNewestFirst = isShownNewestFirst(list);
  const start = isNewestFirst ? (from === undefined ? -pageSize : Math.max(from - pageSize, 0)) : (from ?? 0);
  const limit = isNewestFirst && from !== undefined ? from - start : pageSize;
  const page = await source.page(list.name, start, limit);
  const rows = page.rows.map((bytes) => decodeObject(bytes, schema).data);
  const end = page.start + rows.length;
  const hasRowsBefore = page.start > 0;
  const hasRowsAfter = end < page.rowCount;
  const placeFrom = (from?: number): Place => ({ list: list.name, ...(from === undefined ? {} : { from }) });
  const neighbours = isNewestFirst
    ? {
        ...(hasRowsAfter && { previous: placeFrom(end + pageSize < page.rowCount ? end + pageSize : undefined) }),
        ...(hasRowsBefore && { next: placeFrom(page.start) }),
      }
    : {
        ...(hasRowsBefore && { previous: placeFrom(page.start > pageSize ? page.start - pageSize : undefined) }),
        ...(hasRowsAfter && { next: placeFrom(end) }),
      };
  return {
    columns,
    rows: isNewestFirst ? rows.reverse() : rows,
    start: page.start,
    rowCount: page.rowCount,
    ...neighbours,
  };
}
