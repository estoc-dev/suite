import {
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  json,
  type Link,
  linkOf,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Index, MemoryBackend, Store, type View, view } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);

const newStore = () => new Store(json, new MemoryBackend());

async function listed(store: { mine(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

describe("a staged batch", () => {
  it("gives the blobs of the batch that what it writes as mine leads to, and those the store holds", async () => {
    const store = newStore();
    const held = object({ text: "held" });
    await store.write({ mine: [held], blobs: [anything.bytes] });
    const image = utf8("an image");
    const note = object({ image: { $link: linkOf(image) }, held: { $link: held.link } });
    const staged = await store.stage({ mine: [note], blobs: [image] });
    expect(await staged.get(note.link)).toEqual(note.bytes);
    expect(await staged.get(linkOf(image))).toEqual(image);
    expect(await staged.get(held.link)).toEqual(held.bytes);
    expect(await staged.get(anything.link)).toEqual(anything.bytes);
  });

  it("gives none of the blobs of the batch that nothing it writes as mine leads to", async () => {
    const store = newStore();
    const stray = utf8("led to by nothing written");
    const carried = object({ text: "carried" });
    const staged = await store.stage({
      mine: [object({ text: "hello" })],
      blobs: [stray, carried.bytes, anything.bytes],
    });
    expect(await staged.get(linkOf(stray))).toBeUndefined();
    expect(await staged.get(carried.link)).toBeUndefined();
  });

  it("lists what the store lists and what the batch writes as mine, each once", async () => {
    const store = newStore();
    const [first, second, third] = [object({ text: "first" }), object({ text: "second" }), object({ text: "third" })];
    await store.write({ mine: [first], blobs: [anything.bytes] });
    const staged = await store.stage({ mine: [first, second, second, third] });
    expect((await listed(staged)).sort()).toEqual([first.link, second.link, third.link].sort());
  });

  it("is refused as a write of the batch is refused, and leaves the store as it was", async () => {
    const store = newStore();
    const carried = object({ text: "carried" });
    await expect(
      store.stage({ mine: [{ bytes: json.encode([1, 2]) }], blobs: [carried.bytes, anything.bytes] }),
    ).rejects.toThrow(/is not an object/);
    const image = utf8("an image");
    const note = object({ image: { $link: linkOf(image) } });
    await expect(store.stage({ mine: [note], blobs: [carried.bytes, anything.bytes] })).rejects.toThrow(
      `${note.link} leads to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("leaves the store as it was until it is committed", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const staged = await store.stage({ mine: [note], blobs: [anything.bytes] });
    expect(await listed(staged)).toEqual([note.link]);
    expect(await store.get(note.link)).toBeUndefined();
    expect(await store.get(anything.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("writes, once committed, what a write of the batch writes", async () => {
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const batch = { mine: [note], blobs: [image, stray, anything.bytes] };
    const [written, committed] = [newStore(), newStore()];
    await written.write(batch);
    const staged = await committed.stage(batch);
    await staged.commit();
    await staged.commit();
    expect(await listed(committed)).toEqual(await listed(written));
    for (const link of [note.link, linkOf(image), linkOf(stray), anything.link])
      expect(await committed.get(link)).toEqual(await written.get(link));
  });

  it("can still be committed after other writes to the store", async () => {
    const store = newStore();
    const held = object({ text: "held" });
    await store.write({ mine: [held], blobs: [anything.bytes] });
    const note = object({ held: { $link: held.link } });
    const staged = await store.stage({ mine: [note] });
    const other = object({ text: "other" });
    await store.write({ mine: [other, note] });
    await staged.commit();
    expect((await listed(store)).sort()).toEqual([held.link, other.link, note.link].sort());
    expect(await store.get(note.link)).toEqual(note.bytes);
  });

  it("keeps what it will write, whatever happens to the arrays it was given or gave out", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ image: { $link: linkOf(image) } });
    const [givenNote, givenImage] = [new Uint8Array(note.bytes), new Uint8Array(image)];
    const staged = await store.stage({ mine: [{ bytes: givenNote }], blobs: [givenImage, anything.bytes] });
    givenNote.fill(0);
    givenImage.fill(0);
    (await staged.get(note.link))?.fill(0);
    (await staged.get(linkOf(image)))?.fill(0);
    expect(await staged.get(note.link)).toEqual(note.bytes);
    await staged.commit();
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
  });
});

type Note = { readonly text: string; readonly tags: readonly string[]; readonly at: number };

const noteSchema: Schema<Json, Note> = await encodeSchema(
  {
    $schema: DRAFT,
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
const note = (data: Note) => encodeObject(noteSchema, data);

type Row = readonly [tag: string, at: number, note: Link<unknown>];

const byTag: Index<Json, Row, Note> = {
  reads: [noteSchema],
  rows: ({ link, data }) => data.tags.map((tag) => [tag, data.at, link] as const),
};

const texts: View<Json, Row, Promise<[tag: string, text: string][]>, Note> = {
  index: byTag,
  async read(rows, reader) {
    const texts: [tag: string, text: string][] = [];
    for await (const [tag, , link] of rows.range([]))
      texts.push([tag, (await readObject(reader, link, noteSchema)).data.text]);
    return texts;
  },
};

describe("a view of a staged batch", () => {
  it("is the view of the store once the batch is committed", async () => {
    const store = newStore();
    await store.write({ mine: [note({ text: "soup", tags: ["lunch"], at: 1 })], blobs: [noteSchema.bytes] });
    const staged = await store.stage({
      mine: [note({ text: "salad", tags: ["lunch", "dinner"], at: 2 })],
      blobs: [note({ text: "stew", tags: ["dinner"], at: 3 }).bytes],
    });
    const before = await view(staged, texts);
    await staged.commit();
    expect(before).toEqual(await view(store, texts));
    expect(before).toEqual([
      ["dinner", "salad"],
      ["lunch", "soup"],
      ["lunch", "salad"],
    ]);
  });
});
