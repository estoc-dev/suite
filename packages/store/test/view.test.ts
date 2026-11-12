import { encodeObject, type Json, json, type Link, objectsOf, readObject } from "@estoc/object";
import { array, type DataOf, integer, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { indexOver, MemoryBackend, type OrderedIndex, Store, selectedRecords, type View, view } from "../src/index.ts";

const noteSchema = schema("Note", { text: string(), tags: array(string()), at: integer() });
type Note = DataOf<typeof noteSchema>;

const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });
type Tagged = DataOf<typeof taggedSchema>;
type TaggedOrder = readonly ["tag", "at"];

const byTag: OrderedIndex<Json, Tagged, TaggedOrder> = indexOver(
  selectedRecords(objectsOf(noteSchema)),
  taggedSchema,
  ({ link, data }) => data.tags.map((tag) => ({ tag, at: data.at, note: { $link: link } })),
).orderedBy("tag", "at");

interface Latest {
  noteTagged(tag: string): Promise<Note | undefined>;
}

const latest: View<Json, Tagged, TaggedOrder, Latest> = {
  index: byTag,
  read: (rows, reader) => ({
    async noteTagged(tag) {
      let last: Link<unknown> | undefined;
      for await (const { data } of rows.range([tag])) last = data.note.$link;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

const write = (store: Store, ...notes: Note[]) =>
  store.write({
    records: notes.map((note) => encodeObject(noteSchema, note)),
    blobs: [noteSchema.bytes],
  });

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
    expect(await notes.noteTagged("lunch")).toMatchObject({ text: "salad" });
    expect(await notes.noteTagged("dinner")).toMatchObject({ text: "stew" });
    expect(await notes.noteTagged("breakfast")).toBeUndefined();
  });

  it("stays as the store was when viewed, and takes in later writes when viewed again", async () => {
    const store = new Store(json, new MemoryBackend());
    await write(store, { text: "soup", tags: ["lunch"], at: 1 });
    const before = await view(store, latest);
    await write(store, { text: "salad", tags: ["lunch"], at: 2 });
    expect(await before.noteTagged("lunch")).toMatchObject({ text: "soup" });
    expect(await (await view(store, latest)).noteTagged("lunch")).toMatchObject({ text: "salad" });
  });

  it("is what `read` resolves to, when it gives a promise", async () => {
    const tags: View<Json, Tagged, TaggedOrder, Promise<Set<string>>> = {
      index: byTag,
      async read(rows) {
        const tags = new Set<string>();
        for await (const { data } of rows.range([])) tags.add(data.tag);
        return tags;
      },
    };
    const store = new Store(json, new MemoryBackend());
    await write(store, { text: "soup", tags: ["lunch"], at: 1 }, { text: "salad", tags: ["lunch", "dinner"], at: 2 });
    expect(await view(store, tags).then((tags) => [...tags])).toEqual(["dinner", "lunch"]);
  });
});
