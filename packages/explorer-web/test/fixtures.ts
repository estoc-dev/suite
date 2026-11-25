import { actionSchema, type ListData, listSchema } from "@estoc/explorer";
import {
  encodeObject,
  itself,
  type Link,
  LinkValue,
  linkOf,
  objectFormat,
  type Reader,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { integer, link, optional, schema, string } from "@estoc/schema";
import type { ActionSource } from "../src/action-page.ts";
import type { Source } from "../src/list-page.ts";

export const entrySchema = schema("Entry", { name: string(), count: integer(), to: optional(link()) });

export const entriesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `entry ${index}`, count: index }));

export function readerOf(...blobs: readonly Uint8Array[]): Reader {
  return new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
}

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

/**
 * Gives the pages of `lists` by the rule of a runtime, reading the rows as they are when it is
 * asked, and lists no action.
 */
export function sourceOf(...lists: readonly GivenList[]): Source & ActionSource {
  const blobs = readerOf(...lists.flatMap(({ rowSchema }) => rowSchema.blobs));
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
    actions: async () => [],
    perform: async () => {
      throw new Error("the source performs no action");
    },
  };
}

export function sourceHolding<S extends Reader>(source: S, ...blobs: readonly Uint8Array[]): S {
  const held = readerOf(...blobs);
  return { ...source, get: async (link) => (await held.get(link)) ?? source.get(link) };
}

/** `perform` is given the data of a request, and gives the data of the result and what it committed. */
export interface GivenAction {
  readonly requestSchema: Schema;
  readonly resultSchema: Schema;
  readonly targetSchemas?: { readonly [field: string]: Schema };
  perform(request: ValueMap): Promise<{ result: ValueMap; commits: Link<unknown>[] }>;
}

/** Lists `actions` and performs them as a runtime does, and gives the blobs of the schemas they name. */
export function sourceWithActions<S extends Pick<ActionSource, "get">>(
  source: S,
  ...actions: readonly GivenAction[]
): S & ActionSource {
  const held = sourceHolding(
    source,
    ...actions.flatMap(({ requestSchema, resultSchema, targetSchemas = {} }) =>
      [requestSchema, resultSchema, ...Object.values(targetSchemas)].flatMap(({ blobs }) => blobs),
    ),
  );
  return {
    ...held,
    actions: async () =>
      actions.map(({ requestSchema, resultSchema, targetSchemas = {} }) =>
        encodeObject(actionSchema, {
          request: new LinkValue(requestSchema.link),
          result: new LinkValue(resultSchema.link),
          targetSchemas: Object.fromEntries(
            Object.entries(targetSchemas).map(([field, { link }]) => [field, new LinkValue(link)]),
          ),
        }),
      ),
    async perform(request) {
      const { schema, data } = objectFormat.decode(request);
      const action = actions.find(({ requestSchema }) => requestSchema.link === schema);
      if (action === undefined || schema === itself) throw new Error("no action takes that request");
      const { result, commits } = await action.perform(action.requestSchema.validate(data));
      return { result: encodeObject(action.resultSchema, result).bytes, commits };
    },
  };
}
