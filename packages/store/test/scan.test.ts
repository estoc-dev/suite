import { encodeObject, encodeSchema, json, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MemoryBackend, scan, Store, type Backend, type Index, type Key, type Rows } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const [note, tag] = await Promise.all(["Note", "Tag"].map((title) => encodeSchema({ $schema: DRAFT, title }, defaultValidator)));
const schemas = [note!.bytes, tag!.bytes];

const byKeys: Index<Json, Key> = { reads: [note!], rows: ({ data }) => (data as { keys: Key[] }).keys };

async function all<K extends Key>(range: AsyncIterable<K>): Promise<K[]> {
  const rows: K[] = [];
  for await (const row of range) rows.push(row);
  return rows;
}

const whole = <K extends Key>(rows: Rows<K>) => all(rows.range([]));

describe("an index scanned from a store", () => {
  it("holds the rows of what is written as mine, of the schemas it reads", async () => {
    const store = new Store(json, new MemoryBackend());
    const unlisted = encodeObject(note!, { keys: [["unlisted"]] });
    await store.write({
      mine: [encodeObject(note!, { keys: [["b"], ["a"]] }), encodeObject(tag!, { keys: [["tag"]], of: { $link: unlisted.link } })],
      blobs: [unlisted.bytes, ...schemas],
    });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
  });

  it("holds a row once, however many objects give it", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ mine: [encodeObject(note!, { keys: [["a"]], n: 1 }), encodeObject(note!, { keys: [["a"], ["a"]], n: 2 })], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
  });

  it("gives the rows that start with a prefix, a key before longer ones and a number before a string", async () => {
    const store = new Store(json, new MemoryBackend());
    const keys = [["b", 2], ["a", "x"], ["a", 10], ["a", 9], ["a"], [1], ["ab"]];
    await store.write({ mine: [encodeObject(note!, { keys })], blobs: schemas });
    const rows = await scan(store, byKeys);
    expect(await whole(rows)).toEqual([[1], ["a"], ["a", 9], ["a", 10], ["a", "x"], ["ab"], ["b", 2]]);
    expect(await all(rows.range(["a"]))).toEqual([["a"], ["a", 9], ["a", 10], ["a", "x"]]);
    expect(await all(rows.range(["a", 10]))).toEqual([["a", 10]]);
    expect(await all(rows.range(["c"]))).toEqual([]);
  });

  it("takes as a prefix any start of its keys, of the types they hold there", async () => {
    type Path = readonly [namespace: string, ...path: string[]];
    const paths: Index<Json, Path> = { reads: [note!], rows: ({ data }) => (data as { keys: Path[] }).keys };
    const store = new Store(json, new MemoryBackend());
    await store.write({ mine: [encodeObject(note!, { keys: [["notes", "a", "b"], ["tags", "a"], ["notes"]] })], blobs: schemas });
    const rows = await scan(store, paths);
    expect(await whole(rows)).toEqual([["notes"], ["notes", "a", "b"], ["tags", "a"]]);
    expect(await all(rows.range(["notes"]))).toEqual([["notes"], ["notes", "a", "b"]]);
    expect(await all(rows.range(["notes", "a"]))).toEqual([["notes", "a", "b"]]);
    // @ts-expect-error: a namespace is a string
    expect(await all(rows.range([1]))).toEqual([]);
  });

  it("is not filled when a row holds a number that is not finite", async () => {
    const numbers: Index<Json, Key> = { reads: [note!], rows: ({ data }) => [[Number(data)]] };
    for (const number of ["-Infinity", "Infinity", "NaN"]) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ mine: [encodeObject(note!, number)], blobs: schemas });
      await expect(scan(store, numbers)).rejects.toThrow("a number that is not finite");
    }
  });

  it("is not filled from a store that holds another blob under a link it lists", async () => {
    const backend = new MemoryBackend();
    const store = new Store(json, backend);
    const [listed, other] = [encodeObject(note!, { keys: [["a"]] }), encodeObject(note!, { keys: [["b"]] })];
    await store.write({ mine: [listed, other], blobs: schemas });
    const swapped: Backend = {
      get: (link) => backend.get(link === listed.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, mine) => backend.put(blobs, mine),
      mine: () => backend.mine(),
    };
    await expect(scan(new Store(json, swapped), byKeys)).rejects.toThrow(`another blob under ${listed.link}`);
  });
});
