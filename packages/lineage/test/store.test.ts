import { encodeObject, type Implementation, type Link, LinkValue } from "@estoc/object";
import { type DataOf, link, schema, string } from "@estoc/schema";
import {
  indexOver,
  MemoryBackend,
  type OrderedIndex,
  Store,
  selectedRecords,
  writtenObjectsOf,
  writtenObjectsOver,
} from "@estoc/store";
import { describe, expect, it } from "vitest";
import { type Lineage, type LineageNodeObject, lineages } from "../src/index.ts";

// An application that keeps notes in series, and records the head of a
// lineage each time it appends a version.

const note = schema("Note", { text: string() });
const first = encodeObject(note, { text: "first" });
const second = encodeObject(note, { text: "second" });
const third = encodeObject(note, { text: "third" });
const other = encodeObject(note, { text: "other" });

const headSchema = schema("Head", { of: link(), head: link<LineageNodeObject>() });
type HeadIndex = OrderedIndex<DataOf<typeof headSchema>, readonly ["of", "head"]>;

const bySeries: HeadIndex = indexOver(
  selectedRecords(writtenObjectsOver(lineages.selection)),
  headSchema,
  function* ({ first, head }) {
    yield { of: new LinkValue(first.link), head: new LinkValue(head.link) };
  },
).orderedBy("of", "head");
const byItem: HeadIndex = indexOver(
  selectedRecords(writtenObjectsOver(lineages.selection)),
  headSchema,
  function* ({ items, head }) {
    for (const item of items) yield { of: new LinkValue(item), head: new LinkValue(head.link) };
  },
).orderedBy("of", "head");

const newStore = () => new Store(new MemoryBackend());

async function recordHeads(store: Store, ...chains: readonly Lineage[]) {
  const notes = [first, second, third, other].map(({ bytes }) => bytes);
  const heads = chains.map(({ head }) => head.link);
  await store.write({ roots: heads, blobs: [...chains.flatMap(({ blobs }) => blobs), ...notes, ...note.blobs] });
  await store.record(writtenObjectsOf(heads, Date.now()));
}

async function readHeads(store: Store, index: HeadIndex, key: Link<unknown>): Promise<Link<LineageNodeObject>[]> {
  const heads: Link<LineageNodeObject>[] = [];
  for await (const { data } of (await store.scan(index)).range([new LinkValue(key)])) heads.push(data.head.link);
  return heads;
}

describe("a lineage written to a store", () => {
  it("is read by the selection from its head, back to its first node", async () => {
    const store = newStore();
    const lineage = lineages.startingWith(first).appending(second);
    await recordHeads(store, lineage);
    const loadedLineage = await lineages.selection.read(lineage.head.link, store);
    expect(loadedLineage?.first.link).toBe(lineage.first.link);
    expect(loadedLineage?.items).toEqual([first.link, second.link]);
  });

  it("goes into an index by series with every head of the series that is recorded", async () => {
    const store = newStore();
    const trunk = lineages.startingWith(first);
    const branch = trunk.appending(second);
    const otherBranch = trunk.appending(third);
    await recordHeads(store, trunk);
    await recordHeads(store, branch, otherBranch, lineages.startingWith(other));
    const heads = await readHeads(store, bySeries, trunk.first.link);
    expect(heads.sort()).toEqual([trunk.head.link, branch.head.link, otherBranch.head.link].sort());
  });

  it("goes into an index by item under each version it holds, those before its head among them", async () => {
    const store = newStore();
    const lineage = lineages.startingWith(first).appending(second).appending(first);
    await recordHeads(store, lineage, lineages.startingWith(other));
    expect(await readHeads(store, byItem, second.link)).toEqual([lineage.head.link]);
    expect(await readHeads(store, byItem, first.link)).toEqual([lineage.head.link]);
    expect(await readHeads(store, byItem, third.link)).toEqual([]);
  });
});

interface TitledText {
  readonly title?: string;
  readonly text: string;
}

const titledNote = schema("Note", { title: string(), body: string() });
const v1: Implementation<TitledText, { readonly text: string }> = {
  schema: note,
  read: ({ data }) => ({ text: data.text }),
};
const v2: Implementation<TitledText, { readonly title: string; readonly body: string }> = {
  schema: titledNote,
  read: ({ data }) => ({ title: data.title, text: data.body }),
};
const notes = lineages.schemaLineageOf([v1, v2]);

describe("the selection of a schema lineage over a store", () => {
  it("gives the rows of the recorded objects of every version, and none of another schema", async () => {
    const store = newStore();
    await recordHeads(store, lineages.startingWith(first));
    const untitled = encodeObject(note, { text: "untitled" });
    const titledObject = encodeObject(titledNote, { title: "Greeting", body: "titled" });
    await store.write({
      roots: [untitled.link, titledObject.link],
      blobs: [untitled.bytes, titledObject.bytes, ...notes.blobs],
    });
    await store.record(writtenObjectsOf([untitled.link, titledObject.link], Date.now()));
    const titled = schema("Titled", { text: string(), title: string() });
    const byText = indexOver(selectedRecords(writtenObjectsOver(notes.selection)), titled, function* ({ text, title }) {
      yield { text, title: title ?? "" };
    }).orderedBy("text");
    const rows: DataOf<typeof titled>[] = [];
    for await (const { data } of (await store.scan(byText)).range([])) rows.push(data);
    expect(rows).toEqual([
      { text: "titled", title: "Greeting" },
      { text: "untitled", title: "" },
    ]);
  });
});
