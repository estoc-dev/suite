import type { Client, ListData } from "@estoc/explorer";
import { decodeObject, type Link, LinkValue, memberOf, type Schema, type Value } from "@estoc/object";
import type { Field } from "@estoc/schema";
import { readSchema } from "./schema.ts";

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
  const { schema, document } = await readSchema(source, link);
  return { schema, columns: Object.entries(document.fields).map(([name, field]) => ({ name, field })) };
}

/**
 * - `rows` are in the order shown, each with a value for each of `columns` in their order, and none
 *   where the row leaves the field out.
 * - `rowCount` is how many rows are under the prefix the page was read under, and `start` how many
 *   of them come before `rows`.
 * - `previous` and `next` are where the pages shown before and after this one read from, each left
 *   out where the list as shown ends.
 */
export interface ListPage {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly (Value | undefined)[])[];
  readonly start: number;
  readonly rowCount: number;
  readonly previous?: number;
  readonly next?: number;
}

/**
 * A list sorted by no field is shown last row first, so it is read from its end. Where such a list
 * adds rows at its end, as one of what a store records does, the newest come first and a row keeps
 * its place, so the page that reads from a place stays the same page while rows are written. Any
 * other list is shown in its own order.
 */
export const isShownLastFirst = ({ order }: ListData) => order.length === 0;

function spanFrom(near: number, step: number): [start: number, limit: number] {
  const far = Math.max(near + step * pageSize, 0);
  return [Math.min(near, far), Math.abs(far - near)];
}

export async function readListPage(
  source: Source,
  list: ListData,
  { schema, columns }: RowSchema,
  prefix: readonly Link<unknown>[],
  from: number | undefined,
): Promise<ListPage> {
  // By how much the count of the rows before a row changes from a row shown to the one shown after it.
  const step = isShownLastFirst(list) ? -1 : 1;
  const inOrderShown = <T>(front: T, end: T): [T, T] => (step > 0 ? [front, end] : [end, front]);
  // Where a list shown last row first begins is not known before it is read, and the runtime counts a
  // negative start from the end of the list.
  const [start, limit] = from === undefined && step < 0 ? [-pageSize, pageSize] : spanFrom(from ?? 0, step);
  const page = await source.page(
    list.name,
    prefix.map((link) => new LinkValue(link)),
    start,
    limit,
  );
  const [near, far] = inOrderShown(page.start, page.start + page.rows.length);
  const [first, last] = inOrderShown(0, page.rowCount);
  // The fields a list is sorted by come first, so the order of its rows is read off the first columns.
  const shownColumns = [
    ...list.order.flatMap((name) => columns.filter((column) => column.name === name)),
    ...columns.filter(({ name }) => !list.order.includes(name)),
  ];
  const rows = page.rows.map((bytes) => {
    const { data } = decodeObject(bytes, schema);
    return shownColumns.map(({ name }) => memberOf(data, name));
  });
  return {
    columns: shownColumns,
    rows: step > 0 ? rows : rows.reverse(),
    start: page.start,
    rowCount: page.rowCount,
    ...(near !== first && { previous: Math.min(Math.max(near - step * pageSize, 0), page.rowCount) }),
    ...(far !== last && { next: far }),
  };
}
