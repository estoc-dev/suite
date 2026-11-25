import type { Schema, ValueMap } from "@estoc/object";
import { any, array, boolean, bytes, type DataOf, integer, link, optional, schema, string } from "@estoc/schema";

/** `id` is one that no call still waiting on the same channel has. */
export const callSchema = schema("Call", { id: integer(), name: string(), parameters: any() });

/** Holds the result of the call of that `id`, or why it failed. */
export const replySchema = schema("Reply", { id: integer(), result: optional(any()), error: optional(string()) });

export interface CallKind<P extends ValueMap, R extends ValueMap> {
  readonly name: string;
  readonly parameters: Schema<P>;
  readonly result: Schema<R>;
}

/** `bytes` is left out for a link the runtime gives no blob for. */
export const blobCall = {
  name: "blob",
  parameters: schema("Blob Parameters", { link: link() }),
  result: schema("Blob Result", { bytes: optional(bytes()) }),
};

/** Each of `lists` is the bytes of a List. */
export const listsCall = {
  name: "lists",
  parameters: schema("Lists Parameters", {}),
  result: schema("Lists Result", { lists: array(bytes()) }),
};

/**
 * - `rows` names the schema that every row of the list is written to.
 * - `order` names the fields the rows are sorted by, and is empty for a list sorted by none.
 * - A list that reads blobs reads every blob the store holds, so a row of it may come of an object
 *   that a stranger sent.
 */
export const listSchema = schema("List", {
  name: string(),
  rows: link<Schema>(),
  order: array(string()),
  readsBlobs: boolean(),
});

export type ListData = DataOf<typeof listSchema>;

/**
 * - The page is of the rows under `prefix`: those that hold its values, in their order, in the
 *   first of the fields the list is sorted by. Every row is under the empty prefix.
 * - `start` and `rowCount` count the rows under `prefix` alone. A `start` below zero counts from
 *   the end of them, and the `start` of the result is where the page begins counted from the front.
 * - `blobCount` is how many blobs the store held when the page was read. A store only grows and a
 *   list comes of the blobs held alone, so every list is as it was while that count is.
 */
export const pageCall = {
  name: "page",
  parameters: schema("Page Parameters", { list: string(), prefix: array(any()), start: integer(), limit: integer() }),
  result: schema("Page Result", { start: integer(), rowCount: integer(), blobCount: integer(), rows: array(bytes()) }),
};

export type Page = DataOf<typeof pageCall.result>;

/** Each of `actions` is the bytes of an Action. */
export const actionsCall = {
  name: "actions",
  parameters: schema("Actions Parameters", {}),
  result: schema("Actions Result", { actions: array(bytes()) }),
};

/**
 * - `request` names the schema that a request of the action is written to, which is what tells the
 *   action from the others, and `result` the schema that its result is written to.
 * - `targetSchemas` is a map. Under the name of a field of the request it holds a link to the
 *   schema that each link of that field is to an object of. The request schema gives the type of
 *   each field. Where the map leaves out a field of links, the schema of what those links are to
 *   is unspecified.
 */
export const actionSchema = schema("Action", {
  request: link<Schema>(),
  result: link<Schema>(),
  targetSchemas: any(),
});

export type ActionData = DataOf<typeof actionSchema>;

/**
 * - `request` is the bytes of an object written to the request schema of an action, and `result`
 *   the bytes of the result of the action. The runtime writes neither of them to the store.
 * - `commits` are the roots written and the statements recorded as the action was performed. When
 *   it fails, what it committed before stays in the store, and the reply holds the reason alone.
 */
export const performCall = {
  name: "perform",
  parameters: schema("Perform Parameters", { request: bytes() }),
  result: schema("Perform Result", { result: bytes(), commits: array(link()) }),
};
