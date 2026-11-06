import { encodeObject, encodeSchema, type Json, type Link, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type LineageNodeObject, loadLineage } from "../src/index.ts";

const lineages = await loadLineage(defaultValidator);
const note: Schema<Json, { readonly text: string }> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Note",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);
const first = encodeObject(note, { text: "first" });
const second = encodeObject(note, { text: "second" });
const third = encodeObject(note, { text: "third" });
const byLink = (blobs: readonly Uint8Array[]) =>
  new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
const linksOf = (nodes: readonly LineageNodeObject[]) => nodes.map((node) => node.link);

describe("a lineage started with an item", () => {
  it("is one node, its first and its head, which names no node before it", () => {
    const lineage = lineages.startingWith(first);
    expect(lineage.nodes).toEqual([lineage.head]);
    expect(lineage.first).toBe(lineage.head);
    expect(lineage.head.data).toEqual({ item: { $link: first.link } });
    expect(lineage.items).toEqual([first.link]);
  });

  it("has the first node of every lineage started with that item", () => {
    const appended = lineages.startingWith(first).appending(second);
    expect(lineages.startingWith(first).first.link).toBe(appended.first.link);
    expect(lineages.startingWith(second).first.link).not.toBe(appended.first.link);
  });
});

describe("appending an item", () => {
  it("keeps the nodes before and names the head as previous", () => {
    const started = lineages.startingWith(first);
    const appended = started.appending(second);
    expect(linksOf(appended.nodes)).toEqual([started.head.link, appended.head.link]);
    expect(appended.first).toBe(started.first);
    expect(appended.head.data).toEqual({ previous: { $link: started.head.link }, item: { $link: second.link } });
    expect(appended.items).toEqual([first.link, second.link]);
  });

  it("leaves the lineage it appends to as it is", () => {
    const started = lineages.startingWith(first);
    started.appending(second);
    expect(started.nodes).toEqual([started.head]);
    expect(started.items).toEqual([first.link]);
  });

  it("forks two lineages from one head, which share the nodes up to it", () => {
    const started = lineages.startingWith(first).appending(second);
    const one = started.appending(third);
    const other = started.appending(first);
    expect(linksOf(one.nodes).slice(0, 2)).toEqual(linksOf(started.nodes));
    expect(linksOf(other.nodes).slice(0, 2)).toEqual(linksOf(started.nodes));
    expect(one.head.link).not.toBe(other.head.link);
  });

  it("puts an item appended twice in two nodes, and keeps both in items", () => {
    const lineage = lineages.startingWith(first).appending(second).appending(second);
    expect(new Set(linksOf(lineage.nodes)).size).toBe(3);
    expect(lineage.items).toEqual([first.link, second.link, second.link]);
  });
});

describe("reading a lineage", () => {
  it("gives back the nodes and items of one built by appending, from its blobs", async () => {
    const built = lineages.startingWith(first).appending(second).appending(third);
    const read = await lineages.read(built.head.link, byLink(built.blobs));
    expect(linksOf(read.nodes)).toEqual(linksOf(built.nodes));
    expect(read.first.link).toBe(built.first.link);
    expect(read.items).toEqual(built.items);
  });

  it("refuses a lineage when the reader gives no blob for a node on the way", async () => {
    const middle = lineages.startingWith(first).appending(second);
    const built = middle.appending(third);
    const blobs = byLink(built.blobs);
    blobs.delete(middle.head.link);
    await expect(lineages.read(built.head.link, blobs)).rejects.toThrow(`no blob is given for ${middle.head.link}`);
  });

  it("refuses a lineage whose previous names an object of another schema", async () => {
    const head = encodeObject(lineages.schema, {
      previous: { $link: first.link as Link<never> },
      item: { $link: second.link },
    });
    const blobs = byLink([head.bytes, ...lineages.schema.blobs, first.bytes, ...note.blobs]);
    await expect(lineages.read(head.link, blobs)).rejects.toThrow(
      `the object is written to ${note.link}, not to ${lineages.schema.link}`,
    );
  });
});
