import { actionSchema, type LinkPage, type ListData, listSchema } from "@estoc/explorer";
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
import type { LinkSource } from "../src/link-page.ts";
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

function pageIn<T>(items: readonly T[], start: number, limit: number): { start: number; items: T[] } {
  const first = start < 0 ? Math.max(items.length + start, 0) : Math.min(start, items.length);
  return { start: first, items: items.slice(first, first + Math.max(limit, 0)) };
}

/**
 * Gives the pages of `lists` by the rule of a runtime, reading the rows as they are when it is
 * asked. It lists no action, and holds no object written to a schema and nothing that links to a blob.
 */
export function sourceOf(...lists: readonly GivenList[]): Source & ActionSource & LinkSource {
  const blobs = readerOf(...lists.flatMap(({ rowSchema }) => rowSchema.blobs));
  const noLinks = async () => ({ start: 0, linkCount: 0, blobCount: 0, links: [] });
  return {
    get: async (link) => blobs.get(link),
    lists: async () => lists.map(({ description }) => encodeObject(listSchema, description)),
    async page(name, start, limit) {
      const list = lists.find(({ description }) => description.name === name);
      if (list === undefined) throw new Error(`there is no list named ${name}`);
      const page = pageIn(list.rows, start, limit);
      return {
        start: page.start,
        rowCount: list.rows.length,
        blobCount: list.rows.length,
        rows: page.items.map((row) => encodeObject(list.rowSchema, row).bytes),
      };
    },
    objectsOf: noLinks,
    sourcesOf: noLinks,
    actions: async () => [],
    perform: async () => {
      throw new Error("the source performs no action");
    },
  };
}

export type LinkPair = readonly [Link<unknown>, Link<unknown>];

/**
 * - Each of `objects` is a schema and an object written to it, and each of `links` a blob and what
 *   links to it.
 * - Gives the pages of them by the rule of a runtime, in the order given.
 */
export function sourceWithLinks<S extends object>(
  source: S,
  { objects = [], links = [] }: { readonly objects?: readonly LinkPair[]; readonly links?: readonly LinkPair[] },
): S & LinkSource {
  const pageUnder = (pairs: readonly LinkPair[], first: Link<unknown>, start: number, limit: number): LinkPage => {
    const held = pairs.flatMap(([link, second]) => (link === first ? [second] : []));
    const page = pageIn(held, start, limit);
    return { start: page.start, linkCount: held.length, blobCount: pairs.length, links: page.items };
  };
  return {
    ...source,
    objectsOf: async (schema, start, limit) => pageUnder(objects, schema, start, limit),
    sourcesOf: async (target, start, limit) => pageUnder(links, target, start, limit),
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
export function sourceWithActions<S extends Pick<ActionSource, "get" | "objectsOf">>(
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
