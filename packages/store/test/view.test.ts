import { encodeObject, encodeSchema, type Json, json, type Link, readObject, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Index, MemoryBackend, Store, type View, view } from "../src/index.ts";

type Note = { readonly text: string; readonly tags: readonly string[]; readonly at: number };

const noteSchema: Schema<Json, Note> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Note",
    type: "object",
    properties: {
      text: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      at: { type: "integer" },
    },
    required: ["text", "tags", "at"],
    additionalProperties: false,
  },
  defaultValidator,
);

type Row = readonly [tag: string, at: number, note: Link<unknown>];

const byTag: Index<Json, Row, Note> = {
  reads: [noteSchema],
  rows: ({ link, data }) => data.tags.map((tag) => [tag, data.at, link] as const),
};

interface Latest {
  of(tag: string): Promise<Note | undefined>;
}

const latest: View<Json, Row, Latest, Note> = {
  index: byTag,
  read: (rows, reader) => ({
    async of(tag) {
      let last: Link<unknown> | undefined;
      for await (const [, , note] of rows.range([tag])) last = note;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

const write = (store: Store, ...notes: Note[]) =>
  store.write({ mine: notes.map((note) => encodeObject(noteSchema, note)), blobs: [noteSchema.bytes] });

describe("the value of a view", () => {
  it("is worked out from the rows of its index, with the store giving the objects they name", async () => {
    const store = new Store(json, new MemoryBackend());
    await write(
      store,
      { text: "stew", tags: ["dinner"], at: 3 },
      { text: "soup", tags: ["lunch"], at: 1 },
      { text: "salad", tags: ["lunch", "dinner"], at: 2 },
    );
    const notes = await view(store, latest);
    expect(await notes.of("lunch")).toMatchObject({ text: "salad" });
    expect(await notes.of("dinner")).toMatchObject({ text: "stew" });
    expect(await notes.of("breakfast")).toBeUndefined();
  });

  it("stays as the store was when viewed, and takes in later writes when viewed again", async () => {
    const store = new Store(json, new MemoryBackend());
    await write(store, { text: "soup", tags: ["lunch"], at: 1 });
    const before = await view(store, latest);
    await write(store, { text: "salad", tags: ["lunch"], at: 2 });
    expect(await before.of("lunch")).toMatchObject({ text: "soup" });
    expect(await (await view(store, latest)).of("lunch")).toMatchObject({ text: "salad" });
  });
});
