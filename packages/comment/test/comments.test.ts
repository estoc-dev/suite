import { encodeObject, encodeSchema, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, PrivateStore, RefusedBatch, Store, view } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { type Commentary, loadComments } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const note = await encodeSchema({ $schema: DRAFT, title: "Note" }, defaultValidator);

/** A clock that gives 1, 2, 3 and so on, one for each comment written. */
function ticking() {
  let now = 0;
  return () => ++now;
}

async function setUp(clock = ticking()) {
  const store = new Store(json, new MemoryBackend());
  const comments = await loadComments({ validator: defaultValidator, clock });
  const object = encodeObject(note, { text: "lunch at noon" });
  await store.write({ mine: [object], blobs: [note.bytes] });
  return { store, comments, object };
}

const texts = async (commentary: Commentary, on: Link<unknown>) => (await commentary.on(on)).map(({ text }) => text);

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("comments", () => {
  it("are written on a blob the store holds, and read by it, oldest first", async () => {
    const { store, comments, object } = await setUp();
    const first = await comments.write(store, object.link, "noon is too early");
    await comments.write(store, object.link, "one, then");
    expect(first).toMatchObject({ on: object.link, text: "noon is too early", at: 1 });
    const commentary = await view(store, comments.view);
    expect(await texts(commentary, object.link)).toEqual(["noon is too early", "one, then"]);
    expect(await commentary.on(object.link)).toContainEqual(first);
  });

  it("written at the same time come in the order of their links", async () => {
    const { store, comments, object } = await setUp(() => 7);
    const written = [
      await comments.write(store, object.link, "b"),
      await comments.write(store, object.link, "a"),
      await comments.write(store, object.link, "c"),
    ];
    const commentary = await view(store, comments.view);
    expect((await commentary.on(object.link)).map(({ link }) => link)).toEqual(written.map(({ link }) => link).sort());
  });

  it("can be on another comment, as a reply", async () => {
    const { store, comments, object } = await setUp();
    const comment = await comments.write(store, object.link, "noon is too early");
    await comments.write(store, comment.link, "it is not");
    const commentary = await view(store, comments.view);
    expect(await texts(commentary, object.link)).toEqual(["noon is too early"]);
    expect(await texts(commentary, comment.link)).toEqual(["it is not"]);
  });

  it("can be on a blob that is not an object, such as a schema", async () => {
    const { store, comments } = await setUp();
    await comments.write(store, note.link, "notes take anything");
    expect(await texts(await view(store, comments.view), note.link)).toEqual(["notes take anything"]);
  });

  it("list each blob they are on once, in the order of their links", async () => {
    const { store, comments, object } = await setUp();
    await comments.write(store, object.link, "noon is too early");
    await comments.write(store, note.link, "notes take anything");
    await comments.write(store, object.link, "one, then");
    const commentary = await view(store, comments.view);
    expect(await all(commentary.commented())).toEqual([object.link, note.link].sort());
    expect(await commentary.on(linkOf(new Uint8Array([1])))).toEqual([]);
  });

  it("are refused on a blob the store does not hold, and nothing is written", async () => {
    const { store, comments } = await setUp();
    const elsewhere = encodeObject(note, { text: "not here" });
    await expect(comments.write(store, elsewhere.link, "where is this")).rejects.toThrow(RefusedBatch);
    expect(await all(store.mine())).toHaveLength(1);
  });

  it("carry what they are on, so a bundle of one holds that too", async () => {
    const { store, comments, object } = await setUp();
    const comment = await comments.write(store, object.link, "noon is too early");
    const closure = await store.closure(comment.link);
    expect(closure.get(object.link)).toEqual(object.bytes);
    expect(closure.get(comments.schema.link)).toEqual(comments.schema.bytes);
  });

  it("kept in a private store are read from it, and not from the store beside", async () => {
    const { store, comments, object } = await setUp();
    const kept = new PrivateStore(store, new MemoryBackend());
    await comments.write(store, object.link, "noon is too early");
    await comments.write(kept, object.link, "they always say that");
    expect(await texts(await view(store, comments.view), object.link)).toEqual(["noon is too early"]);
    expect(await texts(await view(kept, comments.view), object.link)).toEqual(["they always say that"]);
  });

  it("that came from elsewhere are not listed, but are read by link", async () => {
    const { store, comments, object } = await setUp();
    const theirs = comments.encode(object.link, "from someone else", 5);
    const received = encodeObject(note, { received: { $link: theirs.link } });
    await store.write({ mine: [received], blobs: [theirs.bytes, comments.schema.bytes] });
    expect(await texts(await view(store, comments.view), object.link)).toEqual([]);
    expect(await comments.read(theirs.link, store)).toMatchObject({ on: object.link, text: "from someone else" });
  });

  it("are read only as comments", async () => {
    const { store, comments, object } = await setUp();
    await expect(comments.read(object.link, store)).rejects.toThrow(/not to/);
  });
});
