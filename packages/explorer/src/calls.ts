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
 * - `order` names the fields the rows are sorted by, and is empty for a list that keeps the order
 *   its rows were written in.
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
 * - A `start` below zero counts from the end of the list, and the `start` of the result is where
 *   the page begins counted from the front.
 * - `rowCount` is how many rows the list has, and `blobCount` how many blobs the store held when
 *   the page was read. A store only grows and a list comes of the blobs held alone, so every list
 *   is as it was while that count is.
 */
export const pageCall = {
  name: "page",
  parameters: schema("Page Parameters", { list: string(), start: integer(), limit: integer() }),
  result: schema("Page Result", { start: integer(), rowCount: integer(), blobCount: integer(), rows: array(bytes()) }),
};

export type Page = DataOf<typeof pageCall.result>;
