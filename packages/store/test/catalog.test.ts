import { encodeObject, encodeSchema, type Json, json, type Link, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type CatalogEntry, catalog, MemoryBackend, PrivateStore, type Rows, Store, scan } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const titled = (title: string) =>
  encodeSchema(
    { $schema: DRAFT, title, type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    defaultValidator,
  );
const [note, tag] = await Promise.all([titled("Note"), titled("Tag")]);
const schemas = [note.bytes, tag.bytes];

async function all<K>(range: AsyncIterable<K>): Promise<K[]> {
  const rows: K[] = [];
  for await (const row of range) rows.push(row);
  return rows;
}

const objectsOf = async (rows: Rows<CatalogEntry<Json>>, schema: Schema<Json>) =>
  (await all(rows.range([schema.link]))).map(([, object]) => object);
const sorted = (...links: Link<unknown>[]) => [...links].sort();

describe("a catalog of a store", () => {
  it("lists what is written as mine by the schema each object names, in the order of their links", async () => {
    const store = new Store(json, new MemoryBackend());
    const [a, b, c] = [
      encodeObject(note, { text: "a" }),
      encodeObject(note, { text: "b" }),
      encodeObject(note, { text: "c" }),
    ];
    const x = encodeObject(tag, { text: "x" });
    await store.write({ mine: [a, x, b, c], blobs: schemas });
    const rows = await catalog(store, json);
    expect(await objectsOf(rows, note)).toEqual(sorted(a.link, b.link, c.link));
    expect(await objectsOf(rows, tag)).toEqual([x.link]);
    expect(new Set((await all(rows.range([]))).map(([schema]) => schema))).toEqual(new Set([note.link, tag.link]));
  });

  it("leaves out what is not written as mine, such as the blobs an object leads to", async () => {
    const store = new Store(json, new MemoryBackend());
    const unlisted = encodeObject(note, { text: "from elsewhere" });
    const record = encodeObject(tag, { text: "received", of: { $link: unlisted.link } });
    await store.write({ mine: [record], blobs: [unlisted.bytes, ...schemas] });
    const rows = await catalog(store, json);
    expect(await all(rows.range([]))).toEqual([[tag.link, record.link]]);
    expect(await store.get(unlisted.link)).toEqual(unlisted.bytes);
  });

  it("lists an object by the schema it names without checking it, where a scan refuses it", async () => {
    const store = new Store(json, new MemoryBackend());
    const unfit = json.encode(json.object({ title: "no text" }, note.link));
    await store.write({ mine: [{ bytes: unfit }], blobs: schemas });
    const rows = await catalog(store, json);
    expect(await objectsOf(rows, note)).toHaveLength(1);
    await expect(scan(store, { reads: [note], rows: ({ link }) => [[link]] })).rejects.toThrow();
  });

  it("is of what the store held when it was made", async () => {
    const store = new Store(json, new MemoryBackend());
    const first = encodeObject(note, { text: "first" });
    await store.write({ mine: [first], blobs: schemas });
    const before = await catalog(store, json);
    await store.write({ mine: [encodeObject(note, { text: "second" })] });
    expect(await objectsOf(before, note)).toEqual([first.link]);
    expect(await objectsOf(await catalog(store, json), note)).toHaveLength(2);
  });

  it("is made of a private store and of a staged batch as of a store", async () => {
    const store = new Store(json, new MemoryBackend());
    const kept = new PrivateStore(store, new MemoryBackend());
    const shared = encodeObject(note, { text: "shared" });
    const secret = encodeObject(tag, { text: "secret" });
    await store.write({ mine: [shared], blobs: schemas });
    await kept.write({ mine: [secret], blobs: [tag.bytes] });
    expect(await all((await catalog(kept, json)).range([]))).toEqual([[tag.link, secret.link]]);

    const staged = encodeObject(tag, { text: "staged" });
    const rows = await catalog(await store.stage({ mine: [staged], blobs: [tag.bytes] }), json);
    expect(await objectsOf(rows, note)).toEqual([shared.link]);
    expect(await objectsOf(rows, tag)).toEqual([staged.link]);
    expect(await objectsOf(await catalog(store, json), tag)).toEqual([]);
  });
});
