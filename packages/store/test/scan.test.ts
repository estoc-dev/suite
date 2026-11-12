import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Link,
  linkOf,
  objectsOf,
  readObject,
  type SchemaValidator,
  type Selection,
  SelectionBySchema,
} from "@estoc/object";
import {
  array,
  type DataOf,
  integer,
  link,
  optional,
  type SchemaDocument,
  schema,
  schemaValidator,
  string,
} from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  type FieldNames,
  type Index,
  indexOver,
  indexOverBlobs,
  MemoryBackend,
  PrivateStore,
  type Rows,
  Store,
  scan,
} from "../src/index.ts";

// Every field these tests write, each optional, so that a note or a tag holds any of them.
const fields = {
  names: optional(array(string())),
  name: optional(string()),
  n: optional(integer()),
  number: optional(string()),
  of: optional(link()),
  attachments: optional(array(link())),
  card: optional(link()),
  about: optional(link()),
  shared: optional(link()),
};
const note = schema("Note", fields);
const tag = schema("Tag", fields);
type Entry = DataOf<typeof note>;
const schemas = [note, tag].map(({ bytes }) => bytes);
const named = schema("Named", { name: string() });
type Named = DataOf<typeof named>;
type NameIndex = Index<Json, Named>;
const namedOf = ({ data }: { readonly data: Entry }): Named[] => (data.names ?? []).map((name) => ({ name }));

const noteNames: NameIndex = indexOver(objectsOf(note), named, namedOf);
const byName = noteNames.orderedBy("name");

const pair = schema("Pair", { key: string(), value: string() });

/** A selection that reads records as `selection` does, without a schema to route them by. */
const plainSelectionOf = <T>(selection: Selection<T>): Selection<T> => ({
  read: (record, reader) => selection.read(record, reader),
});

/** The data of each row of `range`. */
async function all<F>(range: AsyncIterable<{ readonly data: F }>): Promise<F[]> {
  const rows: F[] = [];
  for await (const { data } of range) rows.push(data);
  return rows;
}

/** The names of all of `rows`, in their order. */
const whole = async (rows: Rows<Json, Named, readonly ["name"]>) => (await all(rows.range([]))).map(({ name }) => name);

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
    const unlistedNote = encodeObject(note, { names: ["unlisted"] });
    await store.write({
      records: [
        encodeObject(note, { names: ["b", "a"] }),
        encodeObject(tag, { names: ["tag"], of: { $link: unlistedNote.link } }),
      ],
      blobs: [unlistedNote.bytes, ...schemas],
    });
    expect(await whole(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("holds a row once, however many objects give it", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { names: ["a"], n: 1 }), encodeObject(note, { names: ["a", "a"], n: 2 })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
  });

  describe("in the order of some fields of its rows", () => {
    const entry = schema("Entry", { name: string(), n: optional(integer()), of: optional(link()) });
    type EntryData = DataOf<typeof entry>;

    async function rowsOf<const By extends FieldNames<EntryData>>(by: By, entries: readonly EntryData[]) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [encodeObject(note, {})], blobs: schemas });
      return scan(store, indexOver(objectsOf(note), entry, () => entries).orderedBy(...by));
    }

    it("gives the rows that hold a prefix, a field left out before any value and numbers in their order", async () => {
      const entries = [{ name: "b", n: 2 }, { name: "a", n: 10 }, { name: "a", n: 9 }, { name: "a" }, { name: "ab" }];
      const rows = await rowsOf(["name", "n"], entries);
      expect(await all(rows.range([]))).toEqual([
        { name: "a" },
        { name: "a", n: 9 },
        { name: "a", n: 10 },
        { name: "ab" },
        { name: "b", n: 2 },
      ]);
      expect(await all(rows.range(["a"]))).toEqual([{ name: "a" }, { name: "a", n: 9 }, { name: "a", n: 10 }]);
      expect(await all(rows.range(["a", 10]))).toEqual([{ name: "a", n: 10 }]);
      expect(await all(rows.range(["a", undefined]))).toEqual([{ name: "a" }]);
      expect(await all(rows.range(["c"]))).toEqual([]);
    });

    it("orders links by their bytes, and rows that hold the same in its fields by their own links", async () => {
      const links = ["x", "y", "z"].map((name) => encodeObject(note, { name }).link).sort();
      const entries = links.flatMap(($link) => ["b", "a"].map((name) => ({ name, of: { $link } })));
      const rows = await rowsOf(["of"], entries);
      const expectedRows = links.flatMap((of) =>
        entries
          .filter((each) => each.of.$link === of)
          .map((each) => encodeObject(entry, each))
          .sort((a, b) => (a.link < b.link ? -1 : 1))
          .map(({ data }) => data),
      );
      expect(await all(rows.range([]))).toEqual(expectedRows);
      expect(await all(rows.range([{ $link: links[1] as Link<unknown> }]))).toEqual(expectedRows.slice(2, 4));
    });

    it("takes as a prefix any start of its fields, of the types they hold", async () => {
      const rows = await rowsOf(["name", "n"], [{ name: "a", n: 1 }]);
      expect(await all(rows.range(["a", 1]))).toEqual([{ name: "a", n: 1 }]);
      // @ts-expect-error: a name is a string
      expect(await all(rows.range([1]))).toEqual([]);
      // @ts-expect-error: `of` does not order these rows
      expect(await all(rows.range(["a", 1, { $link: note.link }]))).toEqual([]);
    });
  });

  it("gives rows that depend on an object's closure, read from the store as they are needed", async () => {
    const { signatures, publish } = loadIdentity([ed25519]);
    const signed = schema("Signed", { signer: link(), object: link() });
    const bySigner = indexOver(objectsOf(signatures.schema), signed, async function* (object, reader) {
      const signature = await signatures.verify(object, reader, noIdentityVersions);
      yield { signer: { $link: signature.signedIdentity.identity.identifier }, object: { $link: signature.object } };
    }).orderedBy("signer");
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
        signatures.schema.bytes,
        ...schemas,
      ],
    });
    const expectedRows = helloSignatures
      .map(({ signedIdentity }) => signedIdentity.identity.identifier)
      .sort()
      .map((signer) => ({ signer: { $link: signer }, object: { $link: hello.link } }));
    expect(await all((await scan(store, bySigner)).range([]))).toEqual(expectedRows);
  });

  it("holds the rows of each index that it is a union of, each row once", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { names: ["a", "b"] }), encodeObject(tag, { names: ["b", "c"] })],
      blobs: schemas,
    });
    const byNoteOrTag = noteNames.union(indexOver(objectsOf(tag), named, namedOf)).orderedBy("name");
    expect(await whole(await scan(store, byNoteOrTag))).toEqual(["a", "b", "c"]);
  });

  it("holds no rows of a record that its selection leaves out", async () => {
    const namedNotes = new SelectionBySchema(note, ({ data }) => data.name);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, { names: [] })],
      blobs: schemas,
    });
    expect(
      await whole(await scan(store, indexOver(namedNotes, named, (name) => [{ name }]).orderedBy("name"))),
    ).toEqual(["a"]);
  });

  it("takes records of several schemas in one selection", async () => {
    const noteOrTag: Selection<{ readonly data: Entry }> = {
      async read(record, reader) {
        return (await objectsOf(note).read(record, reader)) ?? (await objectsOf(tag).read(record, reader));
      },
    };
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { names: ["a"] }), encodeObject(tag, { names: ["b"] })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, indexOver(noteOrTag, named, namedOf).orderedBy("name")))).toEqual(["a", "b"]);
  });

  it("hands each of two selections that take one record what that selection reads it as", async () => {
    const names = indexOver(new SelectionBySchema(note, ({ data }) => data.name), pair, (name) => [
      { key: "name", value: name },
    ]);
    const counts = indexOver(new SelectionBySchema(note, ({ data }) => data.n), pair, (n) => [
      { key: "n", value: String(n) },
    ]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { name: "a", n: 1 })], blobs: schemas });
    expect(await all((await scan(store, names.union(counts).orderedBy("key", "value"))).range([]))).toEqual([
      { key: "n", value: "1" },
      { key: "name", value: "a" },
    ]);
  });

  it("gives the rows of a selection by schema that it gives of a selection reading each record as that one does", async () => {
    const namedNotes = new SelectionBySchema(note, ({ data }) => data.name);
    const namedTags = new SelectionBySchema(tag, ({ data }) => data.name);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, {}), encodeObject(tag, { name: "b" })],
      blobs: schemas,
    });
    const rowsOf = (selections: Selection<string>[]) =>
      scan(
        store,
        selections
          .map((selection) => indexOver(selection, named, (name) => [{ name }]))
          .reduce((a, b) => a.union(b))
          .orderedBy("name"),
      );
    const routedRows = await whole(await rowsOf([namedNotes, namedTags]));
    expect(routedRows).toEqual(["a", "b"]);
    expect(await whole(await rowsOf([plainSelectionOf(namedNotes), plainSelectionOf(namedTags)]))).toEqual(routedRows);
    expect(await whole(await rowsOf([namedNotes, plainSelectionOf(namedTags)]))).toEqual(routedRows);
  });

  it("validates a record once against each schema of the selections by schema that read it", async () => {
    const validationNames: string[] = [];
    const validatorNoting = (name: string): SchemaValidator<Json, SchemaDocument> => ({
      language: schemaValidator.language,
      compile(document) {
        const check = schemaValidator.compile(document);
        return (data) => {
          validationNames.push(name);
          return check(data);
        };
      },
    });
    const noteSchemaNoting = (name: string) => encodeSchema({ title: "Note", fields }, validatorNoting(name));
    const strict = noteSchemaNoting("strict");
    const lax = noteSchemaNoting("lax");
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, {})], blobs: schemas });
    const index = indexOver(objectsOf(strict), named, () => [{ name: "a" }]).union(
      indexOver(objectsOf(strict), named, () => [{ name: "b" }]),
      indexOver(objectsOf(lax), named, () => [{ name: "c" }]),
    );
    expect(await whole(await scan(store, index.orderedBy("name")))).toEqual(["a", "b", "c"]);
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
      if (data.card === undefined) return undefined;
      return (await readObject(reader, data.card.$link, tag)).data.name;
    });
    const nameAs = (key: string, selection: Selection<string>) =>
      indexOver(selection, pair, (value) => [{ key, value }]);
    const rows = await scan(
      new Store(json, backendNoting(requestedLinks, backend)),
      nameAs("a", cardName)
        .union(nameAs("b", cardName), nameAs("b", plainSelectionOf(cardName)))
        .orderedBy("key", "value"),
    );
    expect(await all(rows.range([]))).toEqual([
      { key: "a", value: "Alice" },
      { key: "b", value: "Alice" },
    ]);
    expect(requestedLinks.filter((link) => link === card.link)).toHaveLength(1);
    expect(requestedLinks.filter((link) => link === record.link)).toHaveLength(1);
  });

  it("is not filled when the data of a row does not fit the schema of the index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { n: 1 })], blobs: schemas });
    const misfit = indexOver(objectsOf(note), named, ({ data }) => [{ name: data.n as unknown as string }]);
    await expect(scan(store, misfit.orderedBy("name"))).rejects.toThrow("#/name: not a string");
  });

  it.each([
    ["a schema it reads", note],
    ["a schema it does not read", tag],
  ])("is not filled from a store that holds another blob under a link it lists, of %s", async (_, schema) => {
    const backend = new MemoryBackend();
    const store = new Store(json, backend);
    const [listedObject, other] = [encodeObject(note, { names: ["a"] }), encodeObject(schema, { names: ["b"] })];
    await store.write({ records: [listedObject, other], blobs: schemas });
    const swappedBackend: Backend = {
      get: (link) => backend.get(link === listedObject.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, records) => backend.put(blobs, records),
      records: (start) => backend.records(start),
      blobs: (start) => backend.blobs(start),
      positionOf: (link) => backend.positionOf(link),
    };
    await expect(scan(new Store(json, swappedBackend), byName)).rejects.toThrow(
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
    await store.write({ records: [encodeObject(note, { names: ["a"] })], blobs: schemas });
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
  });
});

describe("an index whose rows give none of what does not read as they expect", () => {
  const about = encodeObject(note, { names: ["a"] });
  const record = encodeObject(note, { about: { $link: about.link } });
  const byAbout = indexOver(objectsOf(note), named, async function* ({ data }, reader) {
    const { about } = data;
    if (about === undefined) return;
    let aboutNames: readonly Named[];
    try {
      aboutNames = namedOf(await readObject(reader, about.$link, note));
    } catch {
      return;
    }
    yield* aboutNames;
  }).orderedBy("name");

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
    expect(await whole(await scan(store, byAbout))).toEqual(["a"]);
  });

  it("is not filled when the store does not hold a blob of a record's closure", async () => {
    const store = await storeGiving({ get: async () => undefined });
    await expect(scan(store, byAbout)).rejects.toThrow(
      `the store lists ${record.link} but does not hold ${about.link} of its closure`,
    );
  });
});

describe("an index scanned again from a store", () => {
  const [first, second] = [encodeObject(note, { names: ["a"] }), encodeObject(note, { names: ["b"] })];

  it("reads only the records listed since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
    await store.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await whole(await scan(store, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).toContain(second.link);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("holds the rows of all the records for another index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first, encodeObject(tag, { names: ["t"] })], blobs: schemas });
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
    expect(await whole(await scan(store, indexOver(objectsOf(tag), named, namedOf).orderedBy("name")))).toEqual(["t"]);
  });

  it("takes in the records that another store on the same backend writes", async () => {
    const backend = new MemoryBackend();
    const [store, other] = [new Store(json, backend), new Store(json, backend)];
    await store.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
    await other.write({ records: [second] });
    expect(await whole(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("reads each record once for scans that overlap", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    const scans = await Promise.all([scan(store, byName), scan(store, byName)]);
    for (const rows of scans) expect(await whole(rows)).toEqual(["a"]);
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
    await scan(store, byName);
    await store.write({ records: [second] });
    isGone = true;
    await expect(scan(store, byName)).rejects.toBe(diskError);
    isGone = false;
    requestedLinks.length = 0;
    expect(await whole(await scan(store, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("reads, on a staged batch, the batch's records on top of the rows its store keeps", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byName);
    requestedLinks.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect(await whole(await scan(stagedStore, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
    expect(await whole(await scan(store, byName))).toEqual(["a"]);
    await stagedStore.commit();
    expect(await whole(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("reads, on a private store, only the records written to it since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, backendNoting(requestedLinks, new MemoryBackend()));
    await privateStore.write({ records: [first], blobs: schemas });
    expect(await whole(await scan(privateStore, byName))).toEqual(["a"]);
    await privateStore.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await whole(await scan(privateStore, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
  });
});

describe("an index scanned in two orders", () => {
  const counted = schema("Counted", { name: string(), n: integer() });
  const countedNotes = indexOver(objectsOf(note), counted, ({ data: { name, n } }) =>
    name === undefined || n === undefined ? [] : [{ name, n }],
  );
  const [byCountedName, byCount] = [countedNotes.orderedBy("name"), countedNotes.orderedBy("n")];
  const [first, second, third] = [
    encodeObject(note, { name: "a", n: 3 }),
    encodeObject(note, { name: "c", n: 1 }),
    encodeObject(note, { name: "b", n: 2 }),
  ];

  it("gives the same rows in each order", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first, second, third], blobs: schemas });
    expect(await all((await scan(store, byCountedName)).range([]))).toEqual([
      { name: "a", n: 3 },
      { name: "b", n: 2 },
      { name: "c", n: 1 },
    ]);
    expect(await all((await scan(store, byCount)).range([]))).toEqual([
      { name: "c", n: 1 },
      { name: "b", n: 2 },
      { name: "a", n: 3 },
    ]);
    expect(await all((await scan(store, byCount)).range([2]))).toEqual([{ name: "b", n: 2 }]);
  });

  it("reads each record once for both orders", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await Promise.all([scan(store, byCountedName), scan(store, byCount)]);
    await scan(store, byCount);
    expect(requestedLinks.filter((link) => link === first.link)).toHaveLength(1);
  });

  it("takes into each order the rows given since it was last scanned in that order", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byCountedName);
    await store.write({ records: [second] });
    await scan(store, byCount);
    await store.write({ records: [third] });
    expect((await all((await scan(store, byCountedName)).range([]))).map(({ name }) => name)).toEqual(["a", "b", "c"]);
    expect((await all((await scan(store, byCount)).range([]))).map(({ n }) => n)).toEqual([1, 2, 3]);
  });

  it("reads, on a staged batch, the batch's records once on top of the rows its store keeps in each order", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byCountedName);
    requestedLinks.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect((await all((await scan(stagedStore, byCount)).range([]))).map(({ n }) => n)).toEqual([1, 3]);
    expect(requestedLinks).not.toContain(first.link);
    expect((await all((await scan(store, byCount)).range([]))).map(({ n }) => n)).toEqual([3]);
  });
});

describe("an index over blobs", () => {
  const tagNames: NameIndex = indexOverBlobs(objectsOf(tag), named, namedOf);
  const byTagName = tagNames.orderedBy("name");
  const carrying = (...blobs: readonly Uint8Array[]) =>
    encodeObject(note, { attachments: blobs.map((blob) => ({ $link: linkOf(blob) })) });

  it("holds the rows of a blob of its schema that no record is, however deep in a record's closure", async () => {
    const deep = encodeObject(tag, { names: ["deep"] });
    const near = encodeObject(tag, { names: ["near"], of: { $link: deep.link } });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(near.bytes)], blobs: [deep.bytes, near.bytes, ...schemas] });
    expect(await whole(await scan(store, byTagName))).toEqual(["deep", "near"]);
    expect(await whole(await scan(store, indexOver(objectsOf(tag), named, namedOf).orderedBy("name")))).toEqual([]);
  });

  it("holds the rows of a record of its schema, and of no blob of another schema", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { names: ["tag"] }), encodeObject(note, { names: ["note"] })],
      blobs: schemas,
    });
    expect(await whole(await scan(store, byTagName))).toEqual(["tag"]);
  });

  it("holds no rows of a blob of the batch that the write did not keep", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, {})],
      blobs: [encodeObject(tag, { names: ["outside the closure"] }).bytes, ...schemas],
    });
    expect(await whole(await scan(store, byTagName))).toEqual([]);
  });

  it("holds no rows of what its selection leaves out", async () => {
    const namedTags = new SelectionBySchema(tag, ({ data }) => data.name);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { name: "a" }), encodeObject(tag, {})],
      blobs: schemas,
    });
    expect(
      await whole(await scan(store, indexOverBlobs(namedTags, named, (name) => [{ name }]).orderedBy("name"))),
    ).toEqual(["a"]);
  });

  it.each([
    ["bytes that are not JSON", new Uint8Array([0xff, 0xfe])],
    ["text", new TextEncoder().encode("an image")],
    ["JSON that is not an object", json.encode([1, 2])],
    ["JSON that names no schema", json.encode({ names: ["no schema"] })],
  ])("passes over %s, and still gives the rows of the other blobs", async (_, blob) => {
    const other = encodeObject(tag, { names: ["other"] });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(blob, other.bytes)], blobs: [blob, other.bytes, ...schemas] });
    expect(await whole(await scan(store, byTagName))).toEqual(["other"]);
  });

  it("passes over a blob that names its schema and does not fit it, and still gives the rows of the other blobs", async () => {
    const document = { title: "Named", fields: { name: string(), names: array(string()) } };
    const strict = encodeSchema<Json, SchemaDocument, Entry>(document, schemaValidator);
    const lax = encodeSchema<Json, SchemaDocument, Entry>(document, {
      language: schemaValidator.language,
      compile: () => () => [],
    });
    const misfit = encodeObject(lax, { names: ["misfit"] });
    const fitting = encodeObject(strict, { name: "a", names: ["fitting"] });
    expect(misfit.schema.link).toBe(strict.link);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [carrying(misfit.bytes, fitting.bytes)],
      blobs: [misfit.bytes, fitting.bytes, strict.bytes, ...schemas],
    });
    expect(await whole(await scan(store, indexOverBlobs(objectsOf(strict), named, namedOf).orderedBy("name")))).toEqual(
      ["fitting"],
    );
  });

  describe("whose selection or rows throw on a blob", () => {
    const [unreadable, readable] = [encodeObject(tag, { names: ["unreadable"] }), encodeObject(tag, { names: ["a"] })];
    const readableNamedOf = (object: { readonly data: Entry }) => {
      const rows = namedOf(object);
      if (rows[0]?.name === "unreadable") throw new Error("does not read");
      return rows;
    };

    async function rowsOf(index: NameIndex) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [unreadable, readable], blobs: schemas });
      return whole(await scan(store, index.orderedBy("name")));
    }

    it.each<[string, NameIndex]>([
      ["selection throws", indexOverBlobs(new SelectionBySchema(tag, readableNamedOf), named, (rows) => rows)],
      ["rows throw", indexOverBlobs(objectsOf(tag), named, readableNamedOf)],
    ])("passes over the blob its %s on, and still gives the rows of the other blobs", async (_, index) => {
      expect(await rowsOf(index)).toEqual(["a"]);
    });

    it("keeps no row that its rows gave of the blob before they threw", async () => {
      const index = indexOverBlobs(objectsOf(tag), named, function* (object) {
        yield* namedOf(object);
        readableNamedOf(object);
      });
      expect(await rowsOf(index)).toEqual(["a"]);
    });
  });

  it("passes over a blob when the data of a row of it does not fit the schema of the index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(tag, { names: ["a"] }), encodeObject(tag, { n: 1 })], blobs: schemas });
    const index = indexOverBlobs(objectsOf(tag), named, (object) => [
      ...namedOf(object),
      ...(object.data.n === undefined ? [] : [{ name: object.data.n as unknown as string }]),
    ]);
    expect(await whole(await scan(store, index.orderedBy("name")))).toEqual(["a"]);
  });

  it("is not filled from something else with a `get` and `records`, which still fills an index of records", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { names: ["a"] })], blobs: schemas });
    const standIn = { get: <T>(link: Link<T>) => store.get(link), records: () => store.records() };
    expect(await whole(await scan(standIn, byName))).toEqual(["a"]);
    for (const index of [byTagName, noteNames.union(tagNames).orderedBy("name")])
      await expect(scan(standIn, index)).rejects.toThrow("lists the blobs an index over blobs reads");
  });

  describe("on a store that fails", () => {
    const attachment = new TextEncoder().encode("an attachment");
    const other = encodeObject(tag, { names: ["other"] });
    const nested = encodeObject(tag, { names: ["nested"] });
    const reaching = encodeObject(tag, { names: ["reaching"], of: { $link: nested.link } });
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
      await expect(scan(store, byTagName)).rejects.toBe(diskError);
      failing.isOn = false;
      expect(await whole(await scan(store, byTagName))).toEqual(["nested", "other", "reaching"]);
    });

    const linkedFrom = (data: Entry) => data.of?.$link;

    it.each<[string, NameIndex]>([
      [
        "its selection reads and catches",
        indexOverBlobs(
          new SelectionBySchema(tag, async ({ data }, reader) => {
            const of = linkedFrom(data);
            if (of === undefined) return undefined;
            try {
              return namedOf(await readObject(reader, of, tag));
            } catch {
              return undefined;
            }
          }),
          named,
          (rows) => rows,
        ),
      ],
      [
        "its rows read",
        indexOverBlobs(objectsOf(tag), named, async function* ({ data }, reader) {
          const of = linkedFrom(data);
          if (of !== undefined) yield* namedOf(await readObject(reader, of, tag));
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
      await expect(scan(store, index.orderedBy("name"))).rejects.toBe(diskError);
      expect(readCount).toBe(2);
    });

    it("is not filled when the store does not hold a blob that it lists", async () => {
      const { store } = await storeGiving(other.link, async () => undefined);
      await expect(scan(store, byTagName)).rejects.toThrow(
        `the store lists ${other.link} but does not hold ${other.link} of its closure`,
      );
    });

    it("is not filled when the store holds another blob under a link", async () => {
      const { store } = await storeGiving(other.link, async () => nested.bytes);
      await expect(scan(store, byTagName)).rejects.toThrow(`another blob under ${other.link}`);
    });
  });

  describe("scanned again", () => {
    const [firstTag, secondTag] = [encodeObject(tag, { names: ["x"] }), encodeObject(tag, { names: ["y"] })];
    const [first, second] = [
      encodeObject(note, { names: ["a"], of: { $link: firstTag.link } }),
      encodeObject(note, { names: ["b"], of: { $link: secondTag.link } }),
    ];

    it("reads only the blobs put since the last scan", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, byTagName))).toEqual(["x"]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await whole(await scan(store, byTagName))).toEqual(["x", "y"]);
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
      await scan(store, byTagName);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      isGone = true;
      await expect(scan(store, byTagName)).rejects.toBe(diskError);
      isGone = false;
      requestedLinks.length = 0;
      expect(await whole(await scan(store, byTagName))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("takes in the blobs that another store on the same backend writes", async () => {
      const backend = new MemoryBackend();
      const [store, other] = [new Store(json, backend), new Store(json, backend)];
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, byTagName))).toEqual(["x"]);
      await other.write({ records: [second], blobs: [secondTag.bytes] });
      expect(await whole(await scan(store, byTagName))).toEqual(["x", "y"]);
    });

    it("goes on with records and with blobs each from where it left off, in a union with an index of records", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      const union = noteNames.union(tagNames).orderedBy("name");
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await whole(await scan(store, union))).toEqual(["a", "x"]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await whole(await scan(store, union))).toEqual(["a", "b", "x", "y"]);
      expect(requestedLinks).toContain(second.link);
      expect(requestedLinks).toContain(secondTag.link);
      expect(requestedLinks).not.toContain(first.link);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("reads, on a staged batch, the blobs the batch keeps on top of the rows its store keeps", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      await scan(store, byTagName);
      requestedLinks.length = 0;
      const stagedStore = await store.stage({
        records: [second],
        blobs: [secondTag.bytes, encodeObject(tag, { names: ["outside the closure"] }).bytes],
      });
      expect(await whole(await scan(stagedStore, byTagName))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
      expect(await whole(await scan(store, byTagName))).toEqual(["x"]);
      await stagedStore.commit();
      expect(await whole(await scan(store, byTagName))).toEqual(["x", "y"]);
    });

    it("reads, on a private store, only the blobs kept in it", async () => {
      const store = new Store(json, new MemoryBackend());
      const privateStore = new PrivateStore(store, new MemoryBackend());
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      const kept = encodeObject(note, { of: { $link: secondTag.link }, shared: { $link: firstTag.link } });
      await privateStore.write({ records: [kept], blobs: [secondTag.bytes] });
      expect(await whole(await scan(privateStore, byTagName))).toEqual(["y"]);
      expect(await whole(await scan(store, byTagName))).toEqual(["x"]);
    });
  });
});
