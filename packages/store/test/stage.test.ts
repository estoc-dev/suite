import { encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { array, type DataOf, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { indexOver, MemoryBackend, type OrderedIndex, Store, selectedBlobs, type View, view } from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  text: optional(string()),
  image: optional(link()),
  held: optional(link()),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);

const newStore = () => new Store(new MemoryBackend());

async function blobsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.blobs()) links.push(link);
  return links;
}

describe("a staged batch", () => {
  it("gives the blobs of the batch in the closures of its roots, and those the store holds", async () => {
    const store = newStore();
    const heldObject = object({ text: "held" });
    await store.write({ roots: [heldObject.link], blobs: [heldObject.bytes, ...anything.blobs] });
    const image = utf8("an image");
    const note = object({ image: new LinkValue(linkOf(image)), held: new LinkValue(heldObject.link) });
    const stagedStore = await store.stage({ roots: [note.link], blobs: [note.bytes, image] });
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    expect(await stagedStore.get(linkOf(image))).toEqual(image);
    expect(await stagedStore.get(heldObject.link)).toEqual(heldObject.bytes);
    expect(await stagedStore.get(anything.link)).toEqual(anything.bytes);
  });

  it("gives none of the blobs of the batch outside the closures of its roots", async () => {
    const store = newStore();
    const stray = utf8("led to by nothing written");
    const carriedObject = object({ text: "carried" });
    const hello = object({ text: "hello" });
    const stagedStore = await store.stage({
      roots: [hello.link],
      blobs: [hello.bytes, stray, carriedObject.bytes, ...anything.blobs],
    });
    expect(await stagedStore.get(linkOf(stray))).toBeUndefined();
    expect(await stagedStore.get(carriedObject.link)).toBeUndefined();
  });

  it("is refused as a write of the batch is refused, and leaves the store as it was", async () => {
    const store = newStore();
    const carriedObject = object({ text: "carried" });
    const image = utf8("an image");
    const note = object({ image: new LinkValue(linkOf(image)) });
    await expect(
      store.stage({ roots: [note.link], blobs: [note.bytes, carriedObject.bytes, ...anything.blobs] }),
    ).rejects.toThrow(`${note.link} links to ${linkOf(image)}, which neither the batch nor the store holds`);
    expect(await blobsOf(store)).toEqual([]);
  });

  it("leaves the store as it was until it is committed", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const stagedStore = await store.stage({ roots: [note.link], blobs: [note.bytes, ...anything.blobs] });
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    expect(await store.get(note.link)).toBeUndefined();
    expect(await store.get(anything.link)).toBeUndefined();
    expect(await blobsOf(store)).toEqual([]);
  });

  it("writes, once committed, what a write of the batch writes", async () => {
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const note = object({ text: "hello", image: new LinkValue(linkOf(image)) });
    const batch = { roots: [note.link], blobs: [note.bytes, image, stray, ...anything.blobs] };
    const [writtenStore, committedStore] = [newStore(), newStore()];
    await writtenStore.write(batch);
    const stagedStore = await committedStore.stage(batch);
    await stagedStore.commit();
    await stagedStore.commit();
    expect(await blobsOf(committedStore)).toEqual(await blobsOf(writtenStore));
    for (const link of [note.link, linkOf(image), linkOf(stray), anything.link])
      expect(await committedStore.get(link)).toEqual(await writtenStore.get(link));
  });

  it("can still be committed after other writes to the store", async () => {
    const store = newStore();
    const heldObject = object({ text: "held" });
    await store.write({ roots: [heldObject.link], blobs: [heldObject.bytes, ...anything.blobs] });
    const note = object({ held: new LinkValue(heldObject.link) });
    const stagedStore = await store.stage({ roots: [note.link], blobs: [note.bytes] });
    const other = object({ text: "other" });
    await store.write({ roots: [other.link, note.link], blobs: [other.bytes, note.bytes] });
    await stagedStore.commit();
    expect(await store.get(other.link)).toEqual(other.bytes);
    expect(await store.get(note.link)).toEqual(note.bytes);
  });

  it("keeps what it will write, whatever happens to the arrays it was given or gave out", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ image: new LinkValue(linkOf(image)) });
    const [givenNote, givenImage] = [new Uint8Array(note.bytes), new Uint8Array(image)];
    const stagedStore = await store.stage({
      roots: [note.link],
      blobs: [givenNote, givenImage, ...anything.blobs],
    });
    givenNote.fill(0);
    givenImage.fill(0);
    (await stagedStore.get(note.link))?.fill(0);
    (await stagedStore.get(linkOf(image)))?.fill(0);
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    await stagedStore.commit();
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
  });
});

const noteSchema = schema("Note", { text: string(), tags: array(string()), at: integer() });
type Note = DataOf<typeof noteSchema>;
const note = (data: Note) => encodeObject(noteSchema, data);

const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });
type Tagged = DataOf<typeof taggedSchema>;
type TaggedOrder = readonly ["tag", "at"];

const byTag: OrderedIndex<Tagged, TaggedOrder> = indexOver(
  selectedBlobs(objectsOf(noteSchema)),
  taggedSchema,
  ({ link, data }) => data.tags.map((tag) => ({ tag, at: data.at, note: new LinkValue(link) })),
).orderedBy("tag", "at");

const texts: View<Tagged, TaggedOrder, Promise<[tag: string, text: string][]>> = {
  index: byTag,
  async read(rows, reader) {
    const texts: [tag: string, text: string][] = [];
    for await (const { data } of rows.range([]))
      texts.push([data.tag, (await readObject(reader, data.note.link, noteSchema)).data.text]);
    return texts;
  },
};

/** Stands for a view that gives an object with methods, whose rows are read after `view` has returned. */
const textsWhenAsked: View<Tagged, TaggedOrder, () => Promise<[tag: string, text: string][]>> = {
  index: byTag,
  read: (rows, reader) => () => texts.read(rows, reader),
};

describe("a view of a staged batch", () => {
  it("is the view of the store once the batch is committed, when nothing else is written in between", async () => {
    const store = newStore();
    const [soup, salad] = [
      note({ text: "soup", tags: ["lunch"], at: 1 }),
      note({ text: "salad", tags: ["lunch", "dinner"], at: 2 }),
    ];
    await store.write({ roots: [soup.link], blobs: [soup.bytes, ...noteSchema.blobs] });
    const stagedStore = await store.stage({
      roots: [salad.link],
      blobs: [salad.bytes, note({ text: "stew", tags: ["dinner"], at: 3 }).bytes],
    });
    const before = await view(stagedStore, texts);
    await stagedStore.commit();
    expect(before).toEqual(await view(store, texts));
    expect(before).toEqual([
      ["dinner", "salad"],
      ["lunch", "soup"],
      ["lunch", "salad"],
    ]);
  });

  it("takes in, when viewed again, what is written to the store after the batch was staged, and the batch is still committed", async () => {
    const store = newStore();
    const salad = note({ text: "salad", tags: ["lunch"], at: 1 });
    const stagedStore = await store.stage({ roots: [salad.link], blobs: [salad.bytes, ...noteSchema.blobs] });
    const textsBefore = await view(stagedStore, textsWhenAsked);
    expect(await textsBefore()).toEqual([["lunch", "salad"]]);

    const soup = note({ text: "soup", tags: ["lunch"], at: 2 });
    await store.write({ roots: [soup.link], blobs: [soup.bytes, ...noteSchema.blobs] });
    expect(await (await view(stagedStore, textsWhenAsked))()).toEqual([
      ["lunch", "salad"],
      ["lunch", "soup"],
    ]);
    expect(await textsBefore()).toEqual([["lunch", "salad"]]);

    await stagedStore.commit();
    expect(await store.get(salad.link)).toEqual(salad.bytes);
  });
});
