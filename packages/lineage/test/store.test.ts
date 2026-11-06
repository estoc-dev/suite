import { encodeObject, encodeSchema, type Json, json, type Link, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { indexOver, MemoryBackend, Store, scan } from "@estoc/store";
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

/** Writes the head of each lineage as a record, with its closure: the lineage's blobs and the notes'. */
async function write(store: Store, ...written: readonly Lineage[]) {
  const notes = [first, second, third, other].map(({ bytes }) => bytes);
  await store.write({
    records: written.map(({ head }) => head),
    blobs: [...written.flatMap(({ blobs }) => blobs), ...notes, ...note.blobs],
  });
}

async function headsOf(store: Store, series: Link<LineageNodeObject>): Promise<Link<LineageNodeObject>[]> {
  const heads: Link<LineageNodeObject>[] = [];
  for await (const [, head] of (await scan(store, bySeries)).range([series])) heads.push(head);
  return heads;
}

describe("a lineage written to a store", () => {
  it("is read by the selection from its head, back to its first node", async () => {
    const store = new Store(json, new MemoryBackend());
    const lineage = lineages.startingWith(first).appending(second);
    await write(store, lineage);
    const read = await lineages.selection.read(lineage.head.link, store);
    expect(read?.first.link).toBe(lineage.first.link);
    expect(read?.items).toEqual([first.link, second.link]);
  });

  it("goes into an index by series with every head of the series written as a record", async () => {
    const store = new Store(json, new MemoryBackend());
    const started = lineages.startingWith(first);
    const appended = started.appending(second);
    const forked = started.appending(third);
    await write(store, started);
    await write(store, appended, forked, lineages.startingWith(other));
    const heads = await headsOf(store, started.first.link);
    expect(heads.sort()).toEqual([started.head.link, appended.head.link, forked.head.link].sort());
  });
});
