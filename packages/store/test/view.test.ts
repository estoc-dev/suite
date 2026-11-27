import { encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { array, type DataOf, integer, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { MemoryBackend, recordedWrittenObjects, Store, type View, view, writtenObjectsOf } from "../src/index.ts";
import { indexOverObjects } from "./objects.ts";

const noteSchema = schema("Note", { text: string(), tags: array(string()), at: integer() });
type Note = DataOf<typeof noteSchema>;

const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });
type Tagged = DataOf<typeof taggedSchema>;

const taggedNotes = indexOverObjects(
  recordedWrittenObjects.linksAt("object"),
  noteSchema,
  taggedSchema,
  ({ link, data }) => data.tags.map((tag) => ({ tag, at: data.at, note: new LinkValue(link) })),
);

interface Latest {
  noteTagged(tag: string): Promise<Note | undefined>;
}

const latest: View<Tagged, Latest> = {
  index: taggedNotes,
  read: (rows, reader) => ({
    async noteTagged(tag) {
      let last: Link<unknown> | undefined;
      for await (const { data } of rows.orderedBy("tag", "at").range([tag])) last = data.note.link;
      return last === undefined ? undefined : (await readObject(reader, last, noteSchema)).data;
    },
  }),
};

const newStore = () => new Store(new MemoryBackend());

async function record(store: Store, ...notes: Note[]): Promise<void> {
  const objects = notes.map((note) => encodeObject(noteSchema, note));
  const links = objects.map(({ link }) => link);
  await store.write({ roots: links, blobs: [...objects.map(({ bytes }) => bytes), ...noteSchema.blobs] });
  await store.record(writtenObjectsOf(links, Date.now()));
}

describe("the value of a view", () => {
  it("is worked out from the rows of its index, with what it is viewed on giving the objects they name", async () => {
    const store = newStore();
    await record(
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

  it("stays as it was when viewed, and takes in later writes when viewed again", async () => {
    const store = newStore();
    await record(store, { text: "soup", tags: ["lunch"], at: 1 });
    const before = await view(store, latest);
    await record(store, { text: "salad", tags: ["lunch"], at: 2 });
    expect(await before.noteTagged("lunch")).toMatchObject({ text: "soup" });
    expect(await (await view(store, latest)).noteTagged("lunch")).toMatchObject({ text: "salad" });
  });

  it("is what `read` resolves to, when it gives a promise", async () => {
    const tags: View<Tagged, Promise<Set<string>>> = {
      index: taggedNotes,
      async read(rows) {
        const tags = new Set<string>();
        for await (const { data } of rows.orderedBy("tag", "at").range([])) tags.add(data.tag);
        return tags;
      },
    };
    const store = newStore();
    await record(store, { text: "soup", tags: ["lunch"], at: 1 }, { text: "salad", tags: ["lunch", "dinner"], at: 2 });
    expect(await view(store, tags).then((tags) => [...tags])).toEqual(["dinner", "lunch"]);
  });
});
