import { actionSchema, heldLinks, heldObjects, type ListData, listSchema, type PairList } from "@estoc/explorer";
import {
  encodeObject,
  itself,
  type Link,
  LinkValue,
  linkOf,
  objectFormat,
  type Reader,
  type Schema,
  type Value,
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

/** A list of pairs that every runtime has, with a row for each of `pairs`. */
export function pairListOf<First extends string, Second extends string>(
  { name, rowSchema, order }: PairList<First, Second>,
  ...pairs: readonly (readonly [Link<unknown>, Link<unknown>])[]
): GivenList {
  const [first, second] = order;
  const rows = pairs.map((pair) => ({ [first]: new LinkValue(pair[0]), [second]: new LinkValue(pair[1]) }));
  return listOf(name, rows, order, rowSchema);
}

const isSameValue = (held: Value | undefined, asked: Value) =>
  held instanceof LinkValue && asked instanceof LinkValue ? held.link === asked.link : held === asked;

/**
 * Gives the pages of `lists` by the rule of a runtime, reading the rows as they are when it is
 * asked, and lists no action. Schemas and Links have no rows where they are not among `lists`.
 */
export function sourceOf(...lists: readonly GivenList[]): Source & ActionSource {
  const blobs = readerOf(...lists.flatMap(({ rowSchema }) => rowSchema.blobs));
  const unlisted = [pairListOf(heldObjects), pairListOf(heldLinks)];
  return {
    get: async (link) => blobs.get(link),
    lists: async () => lists.map(({ description }) => encodeObject(listSchema, description)),
    async page(name, prefix, start, limit) {
      const list = [...lists, ...unlisted].find(({ description }) => description.name === name);
      if (list === undefined) throw new Error(`there is no list named ${name}`);
      const rowsUnderPrefix = list.rows.filter((row) =>
        prefix.every((value, at) => {
          const field = list.description.order[at];
          return field !== undefined && isSameValue(row[field], value);
        }),
      );
      const { length } = rowsUnderPrefix;
      const first = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
      const rows = rowsUnderPrefix.slice(first, first + Math.max(limit, 0));
      return {
        start: first,
        rowCount: length,
        blobCount: list.rows.length,
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
export function sourceWithActions<S extends Pick<ActionSource, "get" | "page">>(
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
