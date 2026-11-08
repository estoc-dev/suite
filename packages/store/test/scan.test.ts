import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchema,
  json,
  type Link,
  objectsOf,
  readObject,
  type SchemaValidator,
  type Selection,
  SelectionBySchema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  type Index,
  indexOver,
  type Key,
  MemoryBackend,
  PrivateStore,
  type Rows,
  Store,
  scan,
} from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const schemaTitled = (title: string) => encodeSchema({ $schema: DRAFT, title }, defaultValidator);
const [note, tag] = await Promise.all([schemaTitled("Note"), schemaTitled("Tag")]);
const schemas = [note, tag].flatMap(({ blobs }) => blobs);
const keysOf = ({ data }: { readonly data: Json }) => (data as { keys: Key[] }).keys;

const byKeys: Index<Key> = indexOver(objectsOf(note), keysOf);

/** A selection that reads records as `selection` does, without a schema to route them by. */
const plainSelectionOf = <T>(selection: Selection<T>): Selection<T> => ({
  read: (record, reader) => selection.read(record, reader),
});

async function all<K extends Key>(range: AsyncIterable<K>): Promise<K[]> {
  const rows: K[] = [];
  for await (const row of range) rows.push(row);
  return rows;
}

const whole = <K extends Key>(rows: Rows<K>) => all(rows.range([]));

/** `backend`, noting in `got` each link that it is asked for. */
const backendNoting = (got: Link<unknown>[], backend: Backend): Backend => ({
  get: (link) => {
    got.push(link);
    return backend.get(link);
  },
  has: (link) => backend.has(link),
  put: (blobs, records) => backend.put(blobs, records),
  records: (start) => backend.records(start),
});

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
    const { signatures, publish } = await loadIdentity(defaultValidator, [ed25519]);
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
      blobs: [...signed.flatMap(({ signedIdentity }) => signedIdentity.blobs), ...signatures.schema.blobs, ...schemas],
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
    const named = new SelectionBySchema(note, ({ data }) => (typeof data.name === "string" ? data.name : undefined));
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
    const fieldOf = (field: string) => new SelectionBySchema(note, ({ data }) => data[field]);
    const names: Index<Key> = indexOver(fieldOf("name"), (name) => [["name", name as string]]);
    const counts: Index<Key> = indexOver(fieldOf("n"), (n) => [["n", n as number]]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { name: "a", n: 1 })], blobs: schemas });
    expect(await whole(await scan(store, names.union(counts)))).toEqual([
      ["n", 1],
      ["name", "a"],
    ]);
  });

  it("gives the rows of a selection by schema that it gives of a selection reading each record as that one does", async () => {
    const named = new SelectionBySchema(note, ({ data }) => (typeof data.name === "string" ? data.name : undefined));
    const tagged = new SelectionBySchema(tag, ({ data }) => (typeof data.name === "string" ? data.name : undefined));
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, {}), encodeObject(tag, { name: "b" })],
      blobs: schemas,
    });
    const rowsOf = (selections: Selection<string>[]) =>
      scan(
        store,
        selections.map((selection) => indexOver(selection, (name) => [[name]])).reduce((a, b) => a.union(b)),
      );
    const routed = await whole(await rowsOf([named, tagged]));
    expect(routed).toEqual([["a"], ["b"]]);
    expect(await whole(await rowsOf([plainSelectionOf(named), plainSelectionOf(tagged)]))).toEqual(routed);
    expect(await whole(await rowsOf([named, plainSelectionOf(tagged)]))).toEqual(routed);
  });

  it("validates a record once against each schema of the selections by schema that read it", async () => {
    const checked: string[] = [];
    const checking = (name: string): SchemaValidator<Json, JsonSchema> => ({
      language: defaultValidator.language,
      async compile(schema) {
        const check = await defaultValidator.compile(schema);
        return (data) => {
          checked.push(name);
          return check(data);
        };
      },
    });
    const noteChecking = (name: string) => encodeSchema({ $schema: DRAFT, title: "Note" }, checking(name));
    const [strict, lax] = await Promise.all([noteChecking("strict"), noteChecking("lax")]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, {})], blobs: schemas });
    const index = indexOver(objectsOf(strict), () => [["a"]]).union(
      indexOver(objectsOf(strict), () => [["b"]]),
      indexOver(objectsOf(lax), () => [["c"]]),
    );
    expect(await whole(await scan(store, index))).toEqual([["a"], ["b"], ["c"]]);
    expect(checked).toEqual(["strict", "lax"]);
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
    const cardName = new SelectionBySchema(note, async ({ data }, reader) => {
      const { card } = data as { card: { $link: Link<unknown> } };
      return (await readObject(reader, card.$link, tag)).data.name as string;
    });
    const nameAs = (key: string, selection: Selection<string>) => indexOver(selection, (name) => [[key, name]]);
    const rows = await scan(
      new Store(json, backendNoting(got, backend)),
      nameAs("a", cardName).union(nameAs("b", cardName), nameAs("b", plainSelectionOf(cardName))),
    );
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
      records: (start) => backend.records(start),
    };
    await expect(scan(new Store(json, swapped), byKeys)).rejects.toThrow(`another blob under ${listed.link}`);
  });
});

describe("an index scanned again from a store", () => {
  const [first, second] = [encodeObject(note, { keys: [["a"]] }), encodeObject(note, { keys: [["b"]] })];

  it("reads only the records listed since the last scan", async () => {
    const got: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(got, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    await store.write({ records: [second] });
    got.length = 0;
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
    expect(got).toContain(second.link);
    expect(got).not.toContain(first.link);
  });

  it("holds the rows of all the records for another index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first, encodeObject(tag, { keys: [["t"]] })], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    expect(await whole(await scan(store, indexOver(objectsOf(tag), keysOf)))).toEqual([["t"]]);
  });

  it("takes in the records that another store on the same backend writes", async () => {
    const backend = new MemoryBackend();
    const [store, other] = [new Store(json, backend), new Store(json, backend)];
    await store.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    await other.write({ records: [second] });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
  });

  it("reads each record once for scans that overlap", async () => {
    const got: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(got, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    const scans = await Promise.all([scan(store, byKeys), scan(store, byKeys)]);
    for (const rows of scans) expect(await whole(rows)).toEqual([["a"]]);
    expect(got.filter((link) => link === first.link)).toHaveLength(1);
  });

  it("goes on from the last scan that went through, after one that fails", async () => {
    const got: Link<unknown>[] = [];
    const backend = backendNoting(got, new MemoryBackend());
    const gone = new Error("the disk is gone");
    let isGone = false;
    const store = new Store(json, { ...backend, get: (link) => (isGone ? Promise.reject(gone) : backend.get(link)) });
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byKeys);
    await store.write({ records: [second] });
    isGone = true;
    await expect(scan(store, byKeys)).rejects.toBe(gone);
    isGone = false;
    got.length = 0;
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
    expect(got).not.toContain(first.link);
  });

  it("reads, on a staged batch, the batch's records on top of the rows its store keeps", async () => {
    const got: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(got, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byKeys);
    got.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect(await whole(await scan(stagedStore, byKeys))).toEqual([["a"], ["b"]]);
    expect(got).not.toContain(first.link);
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    await stagedStore.commit();
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
  });

  it("reads, on a private store, only the records written to it since the last scan", async () => {
    const got: Link<unknown>[] = [];
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, backendNoting(got, new MemoryBackend()));
    await privateStore.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(privateStore, byKeys))).toEqual([["a"]]);
    await privateStore.write({ records: [second] });
    got.length = 0;
    expect(await whole(await scan(privateStore, byKeys))).toEqual([["a"], ["b"]]);
    expect(got).not.toContain(first.link);
  });
});
