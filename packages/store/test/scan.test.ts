import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchema,
  json,
  type Link,
  linkOf,
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
  indexOverBlobs,
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

const backendNoting = (requestedLinks: Link<unknown>[], backend: Backend): Backend => ({
  get: (link) => {
    requestedLinks.push(link);
    return backend.get(link);
  },
  has: (link) => backend.has(link),
  put: (blobs, records) => backend.put(blobs, records),
  records: (start) => backend.records(start),
  blobs: (start) => backend.blobs(start),
  positionOf: (link) => backend.positionOf(link),
});

describe("an index scanned from a store", () => {
  it("holds the rows of the store's records, of the schemas it reads", async () => {
    const store = new Store(json, new MemoryBackend());
    const unlistedNote = encodeObject(note, { keys: [["unlisted"]] });
    await store.write({
      records: [
        encodeObject(note, { keys: [["b"], ["a"]] }),
        encodeObject(tag, { keys: [["tag"]], of: { $link: unlistedNote.link } }),
      ],
      blobs: [unlistedNote.bytes, ...schemas],
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
        const signature = await signatures.verify(object, reader, noIdentityVersions);
        yield [signature.signedIdentity.identity.root.link, signature.object];
      },
    );
    const signers = [1, 2].map((fill) => SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill)));
    const hello = encodeObject(note, {});
    const helloSignatures = await Promise.all(
      signers.map(async (by) => signatures.actor(by, await publish(by, { at: 0 })).sign(hello)),
    );
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [hello, ...helloSignatures],
      blobs: [
        ...helloSignatures.flatMap(({ signedIdentity }) => signedIdentity.blobs),
        ...signatures.schema.blobs,
        ...schemas,
      ],
    });
    const expectedRows = helloSignatures
      .map(({ signedIdentity }) => signedIdentity.identity.root.link)
      .sort()
      .map((link) => [link, hello.link]);
    expect(await whole(await scan(store, bySigner))).toEqual(expectedRows);
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
    const namedNotes = new SelectionBySchema(note, ({ data }) =>
      typeof data.name === "string" ? data.name : undefined,
    );
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, { keys: [] })],
      blobs: schemas,
    });
    expect(
      await whole(
        await scan(
          store,
          indexOver(namedNotes, (name) => [[name]]),
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
    const namedNotes = new SelectionBySchema(note, ({ data }) =>
      typeof data.name === "string" ? data.name : undefined,
    );
    const namedTags = new SelectionBySchema(tag, ({ data }) => (typeof data.name === "string" ? data.name : undefined));
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
    const routedRows = await whole(await rowsOf([namedNotes, namedTags]));
    expect(routedRows).toEqual([["a"], ["b"]]);
    expect(await whole(await rowsOf([plainSelectionOf(namedNotes), plainSelectionOf(namedTags)]))).toEqual(routedRows);
    expect(await whole(await rowsOf([namedNotes, plainSelectionOf(namedTags)]))).toEqual(routedRows);
  });

  it("validates a record once against each schema of the selections by schema that read it", async () => {
    const validationNames: string[] = [];
    const validatorNoting = (name: string): SchemaValidator<Json, JsonSchema> => ({
      language: defaultValidator.language,
      async compile(schema) {
        const check = await defaultValidator.compile(schema);
        return (data) => {
          validationNames.push(name);
          return check(data);
        };
      },
    });
    const noteSchemaNoting = (name: string) => encodeSchema({ $schema: DRAFT, title: "Note" }, validatorNoting(name));
    const [strict, lax] = await Promise.all([noteSchemaNoting("strict"), noteSchemaNoting("lax")]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, {})], blobs: schemas });
    const index = indexOver(objectsOf(strict), () => [["a"]]).union(
      indexOver(objectsOf(strict), () => [["b"]]),
      indexOver(objectsOf(lax), () => [["c"]]),
    );
    expect(await whole(await scan(store, index))).toEqual([["a"], ["b"], ["c"]]);
    expect(validationNames).toEqual(["strict", "lax"]);
  });

  it("reads a blob from the store once for a record, the record among them, however many selections read it", async () => {
    const backend = new MemoryBackend();
    const card = encodeObject(tag, { name: "Alice" });
    const record = encodeObject(note, { card: { $link: card.link } });
    await new Store(json, backend).write({
      records: [record],
      blobs: [card.bytes, ...schemas],
    });
    const requestedLinks: Link<unknown>[] = [];
    const cardName = new SelectionBySchema(note, async ({ data }, reader) => {
      const { card } = data as { card: { $link: Link<unknown> } };
      return (await readObject(reader, card.$link, tag)).data.name as string;
    });
    const nameAs = (key: string, selection: Selection<string>) => indexOver(selection, (name) => [[key, name]]);
    const rows = await scan(
      new Store(json, backendNoting(requestedLinks, backend)),
      nameAs("a", cardName).union(nameAs("b", cardName), nameAs("b", plainSelectionOf(cardName))),
    );
    expect(await whole(rows)).toEqual([
      ["a", "Alice"],
      ["b", "Alice"],
    ]);
    expect(requestedLinks.filter((link) => link === card.link)).toHaveLength(1);
    expect(requestedLinks.filter((link) => link === record.link)).toHaveLength(1);
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
    const [listedObject, other] = [encodeObject(note, { keys: [["a"]] }), encodeObject(schema, { keys: [["b"]] })];
    await store.write({ records: [listedObject, other], blobs: schemas });
    const swappedBackend: Backend = {
      get: (link) => backend.get(link === listedObject.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, records) => backend.put(blobs, records),
      records: (start) => backend.records(start),
      blobs: (start) => backend.blobs(start),
      positionOf: (link) => backend.positionOf(link),
    };
    await expect(scan(new Store(json, swappedBackend), byKeys)).rejects.toThrow(
      `another blob under ${listedObject.link}`,
    );
  });

  it("does not list the store's blobs when it reads only records", async () => {
    const store = new Store(json, {
      ...backendNoting([], new MemoryBackend()),
      blobs: () => {
        throw new Error("the blobs are listed");
      },
    });
    await store.write({ records: [encodeObject(note, { keys: [["a"]] })], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
  });
});

describe("an index whose rows give none of what does not read as they expect", () => {
  const about = encodeObject(note, { keys: [["a"]] });
  const record = encodeObject(note, { about: { $link: about.link } });
  const byAbout: Index<Key> = indexOver(objectsOf(note), async function* ({ data }, reader) {
    const { about } = data as { about?: { $link: Link<unknown> } };
    if (about === undefined) return;
    let keys: Key[];
    try {
      keys = keysOf(await readObject(reader, about.$link, note));
    } catch {
      return;
    }
    yield* keys;
  });

  async function storeGiving(readOverride: { get?: () => Promise<Uint8Array | undefined> }): Promise<Store> {
    const backend = new (class extends MemoryBackend {
      override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
        return link === about.link && readOverride.get !== undefined ? readOverride.get() : super.get(link);
      }
    })();
    const store = new Store(json, backend);
    await store.write({ records: [record], blobs: [about.bytes, ...schemas] });
    return store;
  }

  it("is not filled when the store throws for a blob of a record's closure, and a later scan reads the record", async () => {
    const readError = new Error("the disk is gone");
    const readOverride: { get?: () => Promise<Uint8Array | undefined> } = {};
    const store = await storeGiving(readOverride);
    readOverride.get = () => Promise.reject(readError);
    await expect(scan(store, byAbout)).rejects.toBe(readError);
    delete readOverride.get;
    expect(await whole(await scan(store, byAbout))).toEqual([["a"]]);
  });

  it("is not filled when the store does not hold a blob of a record's closure", async () => {
    const store = await storeGiving({ get: async () => undefined });
    await expect(scan(store, byAbout)).rejects.toThrow(
      `the store lists ${record.link} but does not hold ${about.link} of its closure`,
    );
  });
});

describe("an index scanned again from a store", () => {
  const [first, second] = [encodeObject(note, { keys: [["a"]] }), encodeObject(note, { keys: [["b"]] })];

  it("reads only the records listed since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    await store.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
    expect(requestedLinks).toContain(second.link);
    expect(requestedLinks).not.toContain(first.link);
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
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    const scans = await Promise.all([scan(store, byKeys), scan(store, byKeys)]);
    for (const rows of scans) expect(await whole(rows)).toEqual([["a"]]);
    expect(requestedLinks.filter((link) => link === first.link)).toHaveLength(1);
  });

  it("goes on from the last scan that went through, after one that fails", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const backend = backendNoting(requestedLinks, new MemoryBackend());
    const diskError = new Error("the disk is gone");
    let isGone = false;
    const store = new Store(json, {
      ...backend,
      get: (link) => (isGone ? Promise.reject(diskError) : backend.get(link)),
    });
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byKeys);
    await store.write({ records: [second] });
    isGone = true;
    await expect(scan(store, byKeys)).rejects.toBe(diskError);
    isGone = false;
    requestedLinks.length = 0;
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("reads, on a staged batch, the batch's records on top of the rows its store keeps", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byKeys);
    requestedLinks.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect(await whole(await scan(stagedStore, byKeys))).toEqual([["a"], ["b"]]);
    expect(requestedLinks).not.toContain(first.link);
    expect(await whole(await scan(store, byKeys))).toEqual([["a"]]);
    await stagedStore.commit();
    expect(await whole(await scan(store, byKeys))).toEqual([["a"], ["b"]]);
  });

  it("reads, on a private store, only the records written to it since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, backendNoting(requestedLinks, new MemoryBackend()));
    await privateStore.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(privateStore, byKeys))).toEqual([["a"]]);
    await privateStore.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await whole(await scan(privateStore, byKeys))).toEqual([["a"], ["b"]]);
    expect(requestedLinks).not.toContain(first.link);
  });
});

describe("an index over blobs", () => {
  const byTagKeys: Index<Key> = indexOverBlobs(objectsOf(tag), keysOf);
  const carrying = (...blobs: readonly Uint8Array[]) =>
    encodeObject(note, { of: blobs.map((blob) => ({ $link: linkOf(blob) })) });

  it("holds the rows of a blob of its schema that no record is, however deep in a record's closure", async () => {
    const deep = encodeObject(tag, { keys: [["deep"]] });
    const near = encodeObject(tag, { keys: [["near"]], of: { $link: deep.link } });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(near.bytes)], blobs: [deep.bytes, near.bytes, ...schemas] });
    expect(await whole(await scan(store, byTagKeys))).toEqual([["deep"], ["near"]]);
    expect(await whole(await scan(store, indexOver(objectsOf(tag), keysOf)))).toEqual([]);
  });

  it("holds the rows of a record of its schema, and of no blob of another schema", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { keys: [["tag"]] }), encodeObject(note, { keys: [["note"]] })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, byTagKeys))).toEqual([["tag"]]);
  });

  it("holds no rows of a blob of the batch that the write did not keep", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, {})],
      blobs: [encodeObject(tag, { keys: [["outside the closure"]] }).bytes, ...schemas],
    });
    expect(await whole(await scan(store, byTagKeys))).toEqual([]);
  });

  it("holds no rows of what its selection leaves out", async () => {
    const named = new SelectionBySchema(tag, ({ data }) => (typeof data.name === "string" ? data.name : undefined));
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { name: "a" }), encodeObject(tag, {})],
      blobs: schemas,
    });
    expect(
      await whole(
        await scan(
          store,
          indexOverBlobs(named, (name) => [[name]]),
        ),
      ),
    ).toEqual([["a"]]);
  });

  it.each([
    ["bytes that are not JSON", new Uint8Array([0xff, 0xfe])],
    ["text", new TextEncoder().encode("an image")],
    ["JSON that is not an object", json.encode([1, 2])],
    ["JSON that names no schema", json.encode({ keys: [["no schema"]] })],
  ])("passes over %s, and still gives the rows of the other blobs", async (_, blob) => {
    const other = encodeObject(tag, { keys: [["other"]] });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(blob, other.bytes)], blobs: [blob, other.bytes, ...schemas] });
    expect(await whole(await scan(store, byTagKeys))).toEqual([["other"]]);
  });

  it("passes over a blob that names its schema and does not fit it, and still gives the rows of the other blobs", async () => {
    const document = { $schema: DRAFT, title: "Named", required: ["name"] };
    const strict = await encodeSchema(document, defaultValidator);
    const lax = await encodeSchema(document, {
      language: defaultValidator.language,
      compile: async () => () => [],
    });
    const misfit = encodeObject(lax, { keys: [["misfit"]] });
    const fitting = encodeObject(strict, { name: "a", keys: [["fitting"]] });
    expect(misfit.schema.link).toBe(strict.link);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [carrying(misfit.bytes, fitting.bytes)],
      blobs: [misfit.bytes, fitting.bytes, ...strict.blobs, ...schemas],
    });
    expect(await whole(await scan(store, indexOverBlobs(objectsOf(strict), keysOf)))).toEqual([["fitting"]]);
  });

  describe("whose selection or rows throw on a blob", () => {
    const [unreadable, readable] = [
      encodeObject(tag, { keys: [["unreadable"]] }),
      encodeObject(tag, { keys: [["a"]] }),
    ];
    const readableKeysOf = (object: { readonly data: Json }) => {
      const keys = keysOf(object);
      if (keys[0]?.[0] === "unreadable") throw new Error("does not read");
      return keys;
    };

    async function rowsOf(index: Index<Key>) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [unreadable, readable], blobs: schemas });
      return whole(await scan(store, index));
    }

    it.each<[string, Index<Key>]>([
      ["selection throws", indexOverBlobs(new SelectionBySchema(tag, readableKeysOf), (keys) => keys)],
      ["rows throw", indexOverBlobs(objectsOf(tag), readableKeysOf)],
    ])("passes over the blob its %s on, and still gives the rows of the other blobs", async (_, index) => {
      expect(await rowsOf(index)).toEqual([["a"]]);
    });

    it("keeps no row that its rows gave of the blob before they threw", async () => {
      const index = indexOverBlobs(objectsOf(tag), function* (object): Iterable<Key> {
        yield* keysOf(object);
        readableKeysOf(object);
      });
      expect(await rowsOf(index)).toEqual([["a"]]);
    });
  });

  it("is not filled when a row holds a number that is not finite", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(tag, {})], blobs: schemas });
    await expect(
      scan(
        store,
        indexOverBlobs(objectsOf(tag), () => [[Number.NaN]]),
      ),
    ).rejects.toThrow("a number that is not finite");
  });

  it("is not filled from something else with a `get` and `records`, which still fills an index of records", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { keys: [["a"]] })], blobs: schemas });
    const standIn = { get: <T>(link: Link<T>) => store.get(link), records: () => store.records() };
    expect(await whole(await scan(standIn, byKeys))).toEqual([["a"]]);
    for (const index of [byTagKeys, byKeys.union(byTagKeys)])
      await expect(scan(standIn, index)).rejects.toThrow("lists the blobs an index over blobs reads");
  });

  describe("on a store that fails", () => {
    const attachment = new TextEncoder().encode("an attachment");
    const other = encodeObject(tag, { keys: [["other"]] });
    const nested = encodeObject(tag, { keys: [["nested"]] });
    const reaching = encodeObject(tag, { keys: [["reaching"]], of: { $link: nested.link } });
    const record = carrying(attachment, other.bytes, reaching.bytes);

    async function storeGiving(failingLink: Link<unknown>, give: () => Promise<Uint8Array | undefined>) {
      const failing = { isOn: true };
      const backend = new MemoryBackend();
      const store = new Store(json, {
        get: (link) => (failing.isOn && link === failingLink ? give() : backend.get(link)),
        has: (link) => backend.has(link),
        put: (blobs, records) => backend.put(blobs, records),
        records: (start) => backend.records(start),
        blobs: (start) => backend.blobs(start),
        positionOf: (link) => backend.positionOf(link),
      });
      await store.write({
        records: [record],
        blobs: [attachment, other.bytes, nested.bytes, reaching.bytes, ...schemas],
      });
      return { store, failing };
    }

    it.each([
      ["an object of its schema", other.link],
      ["a blob of no schema", linkOf(attachment)],
      ["a record of another schema", record.link],
    ])("is not filled when the store throws for %s, and a later scan reads the blob", async (_, link) => {
      const diskError = new Error("the disk is gone");
      const { store, failing } = await storeGiving(link, () => Promise.reject(diskError));
      await expect(scan(store, byTagKeys)).rejects.toBe(diskError);
      failing.isOn = false;
      expect(await whole(await scan(store, byTagKeys))).toEqual([["nested"], ["other"], ["reaching"]]);
    });

    const linkedFrom = (data: Json) => (data as { of?: { $link: Link<unknown> } }).of?.$link;

    it.each<[string, Index<Key>]>([
      [
        "its selection reads and catches",
        indexOverBlobs(
          new SelectionBySchema(tag, async ({ data }, reader) => {
            const of = linkedFrom(data);
            if (of === undefined) return undefined;
            try {
              return keysOf(await readObject(reader, of, tag));
            } catch {
              return undefined;
            }
          }),
          (keys) => keys,
        ),
      ],
      [
        "its rows read",
        indexOverBlobs(objectsOf(tag), async function* ({ data }, reader): AsyncIterable<Key> {
          const of = linkedFrom(data);
          if (of !== undefined) yield* keysOf(await readObject(reader, of, tag));
        }),
      ],
    ])("is not filled when the store throws for what %s", async (_, index) => {
      const diskError = new Error("the disk is gone");
      // The blob is listed too and goes in first, so it is the read through the object that links to it that fails.
      let readCount = 0;
      const { store } = await storeGiving(nested.link, async () => {
        readCount += 1;
        if (readCount === 1) return nested.bytes;
        throw diskError;
      });
      await expect(scan(store, index)).rejects.toBe(diskError);
      expect(readCount).toBe(2);
    });

    it("is not filled when the store does not hold a blob that it lists", async () => {
      const { store } = await storeGiving(other.link, async () => undefined);
      await expect(scan(store, byTagKeys)).rejects.toThrow(
        `the store lists ${other.link} but does not hold ${other.link} of its closure`,
      );
    });

    it("is not filled when the store holds another blob under a link", async () => {
      const { store } = await storeGiving(other.link, async () => nested.bytes);
      await expect(scan(store, byTagKeys)).rejects.toThrow(`another blob under ${other.link}`);
    });
  });

  describe("scanned again", () => {
    const [firstTag, secondTag] = [encodeObject(tag, { keys: [["x"]] }), encodeObject(tag, { keys: [["y"]] })];
    const [first, second] = [
      encodeObject(note, { keys: [["a"]], of: { $link: firstTag.link } }),
      encodeObject(note, { keys: [["b"]], of: { $link: secondTag.link } }),
    ];

    it("reads only the blobs put since the last scan", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"]]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"], ["y"]]);
      expect(requestedLinks.sort()).toEqual([second.link, secondTag.link].sort());
    });

    it("goes on from the last scan that went through, after one that fails", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const backend = backendNoting(requestedLinks, new MemoryBackend());
      const diskError = new Error("the disk is gone");
      let isGone = false;
      const store = new Store(json, {
        ...backend,
        get: (link) => (isGone ? Promise.reject(diskError) : backend.get(link)),
      });
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      await scan(store, byTagKeys);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      isGone = true;
      await expect(scan(store, byTagKeys)).rejects.toBe(diskError);
      isGone = false;
      requestedLinks.length = 0;
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"], ["y"]]);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("takes in the blobs that another store on the same backend writes", async () => {
      const backend = new MemoryBackend();
      const [store, other] = [new Store(json, backend), new Store(json, backend)];
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"]]);
      await other.write({ records: [second], blobs: [secondTag.bytes] });
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"], ["y"]]);
    });

    it("goes on with records and with blobs each from where it left off, in a union with an index of records", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      const union = byKeys.union(byTagKeys);
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, union))).toEqual([["a"], ["x"]]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await whole(await scan(store, union))).toEqual([["a"], ["b"], ["x"], ["y"]]);
      expect(requestedLinks).toContain(second.link);
      expect(requestedLinks).toContain(secondTag.link);
      expect(requestedLinks).not.toContain(first.link);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("reads, on a staged batch, the blobs the batch keeps on top of the rows its store keeps", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      await scan(store, byTagKeys);
      requestedLinks.length = 0;
      const stagedStore = await store.stage({
        records: [second],
        blobs: [secondTag.bytes, encodeObject(tag, { keys: [["outside the closure"]] }).bytes],
      });
      expect(await whole(await scan(stagedStore, byTagKeys))).toEqual([["x"], ["y"]]);
      expect(requestedLinks).not.toContain(firstTag.link);
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"]]);
      await stagedStore.commit();
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"], ["y"]]);
    });

    it("reads, on a private store, only the blobs kept in it", async () => {
      const store = new Store(json, new MemoryBackend());
      const privateStore = new PrivateStore(store, new MemoryBackend());
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      const kept = encodeObject(note, { of: { $link: secondTag.link }, shared: { $link: firstTag.link } });
      await privateStore.write({ records: [kept], blobs: [secondTag.bytes] });
      expect(await whole(await scan(privateStore, byTagKeys))).toEqual([["y"]]);
      expect(await whole(await scan(store, byTagKeys))).toEqual([["x"]]);
    });
  });
});
