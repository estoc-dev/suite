import { encodeObject, type Link, LinkValue, objectsOf, readObject } from "@estoc/object";
import { array, type DataOf, integer, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  indexOver,
  MemoryBackend,
  type OrderedIndex,
  recordsOf,
  Store,
  selectedRecords,
  type View,
  view,
} from "../src/index.ts";

const noteSchema = schema("Note", { text: string(), tags: array(string()), at: integer() });
type Note = DataOf<typeof noteSchema>;

const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });
type Tagged = DataOf<typeof taggedSchema>;
type TaggedOrder = readonly ["tag", "at"];

const byTag: OrderedIndex<Tagged, TaggedOrder> = indexOver(
  selectedRecords(objectsOf(noteSchema)),
  taggedSchema,
  ({ link, data }) => data.tags.map((tag) => ({ tag, at: data.at, note: new LinkValue(link) })),
).orderedBy("tag", "at");

interface Latest {
  noteTagged(tag: string): Promise<Note | undefined>;
}

const latest: View<Tagged, TaggedOrder, Latest> = {
  index: byTag,
  read: (rows, reader) => ({
    async noteTagged(tag) {
      let last: Link<unknown> | undefined;
      for await (const { data } of rows.range([tag])) last = data.note.link;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

function newStores() {
  const backend = new MemoryBackend();
  return { store: new Store(backend) };
}

async function record({ store }: ReturnType<typeof newStores>, ...notes: Note[]): Promise<void> {
  const objects = notes.map((note) => encodeObject(noteSchema, note));
  const links = objects.map(({ link }) => link);
  await store.write({ roots: links, blobs: [...objects.map(({ bytes }) => bytes), ...noteSchema.blobs] });
  await store.writeMarks(recordsOf(links, Date.now()));
}

describe("the value of a view", () => {
  it("is worked out from the rows of its index, with what it is viewed on giving the objects they name", async () => {
    const stores = newStores();
    await record(
      stores,
      { text: "stew", tags: ["dinner"], at: 3 },
      { text: "soup", tags: ["lunch"], at: 1 },
      { text: "salad", tags: ["lunch", "dinner"], at: 2 },
    );
    const notes = await view(stores.store, latest);
    expect(await notes.noteTagged("lunch")).toMatchObject({ text: "salad" });
    expect(await notes.noteTagged("dinner")).toMatchObject({ text: "stew" });
    expect(await notes.noteTagged("breakfast")).toBeUndefined();
  });

  it("stays as it was when viewed, and takes in later writes when viewed again", async () => {
    const stores = newStores();
    await record(stores, { text: "soup", tags: ["lunch"], at: 1 });
    const before = await view(stores.store, latest);
    await record(stores, { text: "salad", tags: ["lunch"], at: 2 });
    expect(await before.noteTagged("lunch")).toMatchObject({ text: "soup" });
    expect(await (await view(stores.store, latest)).noteTagged("lunch")).toMatchObject({ text: "salad" });
  });

  it("is what `read` resolves to, when it gives a promise", async () => {
    const tags: View<Tagged, TaggedOrder, Promise<Set<string>>> = {
      index: byTag,
      async read(rows) {
        const tags = new Set<string>();
        for await (const { data } of rows.range([])) tags.add(data.tag);
        return tags;
      },
    };
    const stores = newStores();
    await record(stores, { text: "soup", tags: ["lunch"], at: 1 }, { text: "salad", tags: ["lunch", "dinner"], at: 2 });
    expect(await view(stores.store, tags).then((tags) => [...tags])).toEqual(["dinner", "lunch"]);
  });
});
