import {
  encodeObject,
  encodeSchema,
  type Implementation,
  type Json,
  json,
  type Link,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { type Index, indexOver, MemoryBackend, Store, scan } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { type Lineage, type LineageNodeObject, loadLineage } from "../src/index.ts";

// An application that keeps notes in series, and writes the head of a
// lineage as a record each time it appends a version.

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
const other = encodeObject(note, { text: "other" });

const bySeries = indexOver(lineages.selection, function* ({ first, head }) {
  yield [first.link, head.link] as const;
});
const byItem = indexOver(lineages.selection, function* ({ items, head }) {
  for (const item of items) yield [item, head.link] as const;
});

async function writeHeads(store: Store, ...chains: readonly Lineage[]) {
  const notes = [first, second, third, other].map(({ bytes }) => bytes);
  await store.write({
    records: chains.map(({ head }) => head),
    blobs: [...chains.flatMap(({ blobs }) => blobs), ...notes, ...note.blobs],
  });
}

async function readHeads(
  store: Store,
  index: Index<readonly [Link<unknown>, Link<LineageNodeObject>]>,
  key: Link<unknown>,
): Promise<Link<LineageNodeObject>[]> {
  const heads: Link<LineageNodeObject>[] = [];
  for await (const [, head] of (await scan(store, index)).range([key])) heads.push(head);
  return heads;
}

describe("a lineage written to a store", () => {
  it("is read by the selection from its head, back to its first node", async () => {
    const store = new Store(json, new MemoryBackend());
    const lineage = lineages.startingWith(first).appending(second);
    await writeHeads(store, lineage);
    const loadedLineage = await lineages.selection.read(lineage.head.link, store);
    expect(loadedLineage?.first.link).toBe(lineage.first.link);
    expect(loadedLineage?.items).toEqual([first.link, second.link]);
  });

  it("goes into an index by series with every head of the series written as a record", async () => {
    const store = new Store(json, new MemoryBackend());
    const trunk = lineages.startingWith(first);
    const branch = trunk.appending(second);
    const otherBranch = trunk.appending(third);
    await writeHeads(store, trunk);
    await writeHeads(store, branch, otherBranch, lineages.startingWith(other));
    const heads = await readHeads(store, bySeries, trunk.first.link);
    expect(heads.sort()).toEqual([trunk.head.link, branch.head.link, otherBranch.head.link].sort());
  });

  it("goes into an index by item under each version it holds, those before its head among them", async () => {
    const store = new Store(json, new MemoryBackend());
    const lineage = lineages.startingWith(first).appending(second).appending(first);
    await writeHeads(store, lineage, lineages.startingWith(other));
    expect(await readHeads(store, byItem, second.link)).toEqual([lineage.head.link]);
    expect(await readHeads(store, byItem, first.link)).toEqual([lineage.head.link]);
    expect(await readHeads(store, byItem, third.link)).toEqual([]);
  });
});

interface TitledText {
  readonly title?: string;
  readonly text: string;
}

const titledNote: Schema<Json, { readonly title: string; readonly body: string }> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Note",
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
    additionalProperties: false,
  },
  defaultValidator,
);
const v1: Implementation<Json, TitledText, { readonly text: string }> = {
  schema: note,
  read: ({ data }) => ({ text: data.text }),
};
const v2: Implementation<Json, TitledText, { readonly title: string; readonly body: string }> = {
  schema: titledNote,
  read: ({ data }) => ({ title: data.title, text: data.body }),
};
const notes = lineages.schemaLineageOf([v1, v2]);

describe("the selection of a schema lineage over a store", () => {
  it("gives the rows of the records of every version, and none of another schema", async () => {
    const store = new Store(json, new MemoryBackend());
    await writeHeads(store, lineages.startingWith(first));
    const untitled = encodeObject(note, { text: "untitled" });
    const titled = encodeObject(titledNote, { title: "Greeting", body: "titled" });
    await store.write({ records: [untitled, titled], blobs: notes.blobs });
    const byText = indexOver(notes.selection, function* ({ text, title }) {
      yield [text, title ?? ""] as const;
    });
    const rows: (readonly [string, string])[] = [];
    for await (const row of (await scan(store, byText)).range([])) rows.push(row);
    expect(rows).toEqual([
      ["titled", "Greeting"],
      ["untitled", ""],
    ]);
  });
});
