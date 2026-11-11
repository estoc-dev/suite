import { encodeObject, type Link, linkOf } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { type LineageNodeObject, lineages } from "../src/index.ts";

const note = schema("Note", { text: string() });
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
    const lineage = lineages.startingWith(first).appending(second);
    expect(lineages.startingWith(first).first.link).toBe(lineage.first.link);
    expect(lineages.startingWith(second).first.link).not.toBe(lineage.first.link);
  });
});

describe("appending an item", () => {
  it("keeps the nodes before and names the head as previous", () => {
    const initialLineage = lineages.startingWith(first);
    const extendedLineage = initialLineage.appending(second);
    expect(linksOf(extendedLineage.nodes)).toEqual([initialLineage.head.link, extendedLineage.head.link]);
    expect(extendedLineage.first).toBe(initialLineage.first);
    expect(extendedLineage.head.data).toEqual({
      previous: { $link: initialLineage.head.link },
      item: { $link: second.link },
    });
    expect(extendedLineage.items).toEqual([first.link, second.link]);
  });

  it("leaves the lineage it appends to as it is", () => {
    const lineage = lineages.startingWith(first);
    lineage.appending(second);
    expect(lineage.nodes).toEqual([lineage.head]);
    expect(lineage.items).toEqual([first.link]);
  });

  it("forks two lineages from one head, which share the nodes up to it", () => {
    const trunk = lineages.startingWith(first).appending(second);
    const branch = trunk.appending(third);
    const otherBranch = trunk.appending(first);
    expect(linksOf(branch.nodes).slice(0, 2)).toEqual(linksOf(trunk.nodes));
    expect(linksOf(otherBranch.nodes).slice(0, 2)).toEqual(linksOf(trunk.nodes));
    expect(branch.head.link).not.toBe(otherBranch.head.link);
  });

  it("puts an item appended twice in two nodes, and keeps both in items", () => {
    const lineage = lineages.startingWith(first).appending(second).appending(second);
    expect(new Set(linksOf(lineage.nodes)).size).toBe(3);
    expect(lineage.items).toEqual([first.link, second.link, second.link]);
  });
});

describe("reading a lineage", () => {
  it("gives back the nodes and items of one built by appending, from its blobs", async () => {
    const builtLineage = lineages.startingWith(first).appending(second).appending(third);
    const loadedLineage = await lineages.read(builtLineage.head.link, byLink(builtLineage.blobs));
    expect(linksOf(loadedLineage.nodes)).toEqual(linksOf(builtLineage.nodes));
    expect(loadedLineage.first.link).toBe(builtLineage.first.link);
    expect(loadedLineage.items).toEqual(builtLineage.items);
  });

  it("refuses a lineage when the reader gives no blob for a node on the way", async () => {
    const middle = lineages.startingWith(first).appending(second);
    const lineage = middle.appending(third);
    const blobs = byLink(lineage.blobs);
    blobs.delete(middle.head.link);
    await expect(lineages.read(lineage.head.link, blobs)).rejects.toThrow(`no blob is given for ${middle.head.link}`);
  });

  it("refuses a lineage whose previous names an object of another schema", async () => {
    const head = encodeObject(lineages.schema, {
      previous: { $link: first.link as Link<never> },
      item: { $link: second.link },
    });
    const blobs = byLink([head.bytes, lineages.schema.bytes, first.bytes, note.bytes]);
    await expect(lineages.read(head.link, blobs)).rejects.toThrow(
      `the object is written to ${note.link}, not to ${lineages.schema.link}`,
    );
  });
});
