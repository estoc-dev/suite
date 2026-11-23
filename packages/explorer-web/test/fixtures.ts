import { type ListData, listSchema } from "@estoc/explorer";
import { encodeObject, type Link, LinkValue, linkOf, type Schema, type ValueMap } from "@estoc/object";
import { integer, link, optional, schema, string } from "@estoc/schema";
import type { Source } from "../src/list-page.ts";

export const entrySchema = schema("Entry", { name: string(), count: integer(), to: optional(link()) });

export const entriesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `entry ${index}`, count: index }));

export interface GivenList {
  readonly description: ListData;
  readonly rowSchema: Schema;
  readonly rows: ValueMap[];
}

export function listOf(
  name: string,
  rows: ValueMap[],
  order: readonly string[] = [],
  rowSchema: Schema = entrySchema,
): GivenList {
  return { description: { name, rows: new LinkValue(rowSchema.link), order, readsBlobs: false }, rowSchema, rows };
}

/** Gives the pages of `lists` by the rule of a runtime, reading the rows as they are when it is asked. */
export function sourceOf(...lists: readonly GivenList[]): Source {
  const blobs = new Map<Link<unknown>, Uint8Array>(
    lists.flatMap(({ rowSchema }) => rowSchema.blobs.map((bytes) => [linkOf(bytes), bytes])),
  );
  return {
    get: async (link) => blobs.get(link),
    lists: async () => lists.map(({ description }) => encodeObject(listSchema, description)),
    async page(name, start, limit) {
      const list = lists.find(({ description }) => description.name === name);
      if (list === undefined) throw new Error(`there is no list named ${name}`);
      const { length } = list.rows;
      const first = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
      const rows = list.rows.slice(first, first + Math.max(limit, 0));
      return {
        start: first,
        rowCount: length,
        blobCount: length,
        rows: rows.map((row) => encodeObject(list.rowSchema, row).bytes),
      };
    },
  };
}
