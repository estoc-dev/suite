import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Link,
  objectsOf,
  readObject,
  type Selection,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Backend, type Index, indexOver, type Key, MemoryBackend, type Rows, Store, scan } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const titled = (title: string) => encodeSchema({ $schema: DRAFT, title }, defaultValidator);
const [note, tag] = await Promise.all([titled("Note"), titled("Tag")]);
const schemas = [note.bytes, tag.bytes];
const keysOf = ({ data }: { readonly data: Json }) => (data as { keys: Key[] }).keys;

const byKeys: Index<Key> = indexOver(objectsOf(note), keysOf);

async function all<K extends Key>(range: AsyncIterable<K>): Promise<K[]> {
  const rows: K[] = [];
  for await (const row of range) rows.push(row);
  return rows;
}

const whole = <K extends Key>(rows: Rows<K>) => all(rows.range([]));

describe("an index scanned from a store", () => {
  it("holds the rows of the store's records, of the schemas it reads", async () => {
    const store = new Store(json, new MemoryBackend());
    const unlisted = encodeObject(note, { keys: [["unlisted"]] });
    await store.write({
      records: [
        encodeObject(note, { keys: [["b"], ["a"]] }),
        encodeObject(tag, { keys: [["tag"]], of: { $link: unlisted.link } }),
      ],
      blobs: [unlisted.bytes, ...schemas],
    });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
  });

  it("holds a row once, however many objects give it", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { keys: [["a"]], n: 1 }), encodeObject(note, { keys: [["a"], ["a"]], n: 2 })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
  });

  it("gives the rows that start with a prefix, a key before longer ones and a number before a string", async () => {
    const store = new Store(json, new MemoryBackend());
    const keys = [["b", 2], ["a", "x"], ["a", 10], ["a", 9], ["a"], [1], ["ab"]];
    await store.write({ records: [encodeObject(note, { keys })], blobs: schemas });
    const rows = await scan(store, byKeys);
    expect(await whole(rows)).toEqual([[1], ["a"], ["a", 9], ["a", 10], ["a", "x"], ["ab"], ["b", 2]]);
    expect(await all(rows.range(["a"]))).toEqual([["a"], ["a", 9], ["a", 10], ["a", "x"]]);
    expect(await all(rows.range(["a", 10]))).toEqual([["a", 10]]);
    expect(await all(rows.range(["c"]))).toEqual([]);
  });

  it("takes as a prefix any start of its keys, of the types they hold there", async () => {
    type Path = readonly [namespace: string, ...path: string[]];
    const paths: Index<Path> = indexOver(objectsOf(note), ({ data }) => (data as { keys: Path[] }).keys);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { keys: [["notes", "a", "b"], ["tags", "a"], ["notes"]] })],
      blobs: schemas,
    });
    const rows = await scan(store, paths);
    expect(await whole(rows)).toEqual([["notes"], ["notes", "a", "b"], ["tags", "a"]]);
    expect(await all(rows.range(["notes"]))).toEqual([["notes"], ["notes", "a", "b"]]);
    expect(await all(rows.range(["notes", "a"]))).toEqual([["notes", "a", "b"]]);
    // @ts-expect-error: a namespace is a string
    expect(await all(rows.range([1]))).toEqual([]);
  });

  it("gives rows that depend on an object's closure, read from the store as they are needed", async () => {
    const { signatures, publish } = await loadIdentity(defaultValidator);
    const bySigner: Index<[signer: string, object: string]> = indexOver(
      objectsOf(signatures.schema),
      async function* (object, reader) {
        const signature = await signatures.verify(object, reader, noVersions);
        yield [signature.signedIdentity.identity.root.link, signature.object];
      },
    );
    const signers = [1, 2].map((fill) => SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill)));
    const hello = encodeObject(note, {});
    const signed = await Promise.all(signers.map(async (by) => signatures.actor(by, await publish(by, 0)).sign(hello)));
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [hello, ...signed],
      blobs: [...signed.flatMap(({ signedIdentity }) => signedIdentity.blobs), signatures.schema.bytes, ...schemas],
    });
    const expected = signed
      .map(({ signedIdentity }) => signedIdentity.identity.root.link)
      .sort()
      .map((link) => [link, hello.link]);
    expect(await whole(await scan(store, bySigner))).toEqual(expected);
  });

  it("holds the rows of each index that it is a union of, each row once", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { keys: [["a"], ["b"]] }), encodeObject(tag, { keys: [["b"], ["c"]] })],
      blobs: schemas,
    });
    const byNoteOrTag = byKeys.union(indexOver(objectsOf(tag), keysOf));
    expect(await whole(await scan(store, byNoteOrTag))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("holds no rows of a record that its selection leaves out", async () => {
    const named: Selection<string> = {
      async read(record, reader) {
        const name = (await objectsOf(note).read(record, reader))?.data.name;
        return typeof name === "string" ? name : undefined;
      },
    };
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, { keys: [] })],
      blobs: schemas,
    });
    expect(
      await whole(
        await scan(
          store,
          indexOver(named, (name) => [[name]]),
        ),
      ),
    ).toEqual([["a"]]);
  });

  it("takes records of several schemas in one selection", async () => {
    const noteOrTag: Selection<{ readonly data: Json }> = {
      async read(record, reader) {
        return (await objectsOf(note).read(record, reader)) ?? (await objectsOf(tag).read(record, reader));
      },
    };
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { keys: [["a"]] }), encodeObject(tag, { keys: [["b"]] })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, indexOver(noteOrTag, keysOf)))).toEqual([["a"], ["b"]]);
  });

  it("hands each of two selections that take one record what that selection reads it as", async () => {
    const fieldOf = (field: string): Selection<Json> => ({
      read: async (record, reader) => (await objectsOf(note).read(record, reader))?.data[field],
    });
    const names: Index<Key> = indexOver(fieldOf("name"), (name) => [["name", name as string]]);
    const counts: Index<Key> = indexOver(fieldOf("n"), (n) => [["n", n as number]]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { name: "a", n: 1 })], blobs: schemas });
    expect(await whole(await scan(store, names.union(counts)))).toEqual([
      ["n", 1],
      ["name", "a"],
    ]);
  });

  it("reads a blob from the store once for a record, the record among them, however many selections read it", async () => {
    const backend = new MemoryBackend();
    const card = encodeObject(tag, { name: "Alice" });
    const record = encodeObject(note, { card: { $link: card.link } });
    await new Store(json, backend).write({
      records: [record],
      blobs: [card.bytes, ...schemas],
    });
    const got: Link<unknown>[] = [];
    const counting: Backend = {
      get: (link) => {
        got.push(link);
        return backend.get(link);
      },
      has: (link) => backend.has(link),
      put: (blobs, records) => backend.put(blobs, records),
      records: () => backend.records(),
    };
    const nameAs = (key: string) =>
      indexOver(objectsOf(note), async function* ({ data }, reader) {
        const { card } = data as { card: { $link: Link<unknown> } };
        const { name } = (await readObject(reader, card.$link, tag)).data as { name: string };
        yield [key, name];
      });
    const rows = await scan(new Store(json, counting), nameAs("a").union(nameAs("b")));
    expect(await whole(rows)).toEqual([
      ["a", "Alice"],
      ["b", "Alice"],
    ]);
    expect(got.filter((link) => link === card.link)).toHaveLength(1);
    expect(got.filter((link) => link === record.link)).toHaveLength(1);
  });

  it("is not filled when a row holds a number that is not finite", async () => {
    const numbers: Index<Key> = indexOver(objectsOf(note), ({ data }) => [[Number(data.number)]]);
    for (const number of ["-Infinity", "Infinity", "NaN"]) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [encodeObject(note, { number })], blobs: schemas });
      await expect(scan(store, numbers)).rejects.toThrow("a number that is not finite");
    }
  });

  it.each([
    ["a schema it reads", note],
    ["a schema it does not read", tag],
  ])("is not filled from a store that holds another blob under a link it lists, of %s", async (_, schema) => {
    const backend = new MemoryBackend();
    const store = new Store(json, backend);
    const [listed, other] = [encodeObject(note, { keys: [["a"]] }), encodeObject(schema, { keys: [["b"]] })];
    await store.write({ records: [listed, other], blobs: schemas });
    const swapped: Backend = {
      get: (link) => backend.get(link === listed.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, records) => backend.put(blobs, records),
      records: () => backend.records(),
    };
    await expect(scan(new Store(json, swapped), byKeys)).rejects.toThrow(`another blob under ${listed.link}`);
  });
});
