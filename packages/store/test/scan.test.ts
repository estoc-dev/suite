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
  MemoryBackend,
  PrivateStore,
  type Rows,
  Store,
  scan,
  selectedBlobs,
  selectedRecords,
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

const noteNames: NameIndex = indexOver(selectedRecords(objectsOf(note)), named, namedOf);
const byName = noteNames.orderedBy("name");

const pair = schema("Pair", { key: string(), value: string() });

/** A selection that reads records as `selection` does, without a schema to route them by. */
const plainSelectionOf = <T>(selection: Selection<T>): Selection<T> => ({
  read: (record, reader) => selection.read(record, reader),
});

async function rowDataOf<F>(range: AsyncIterable<{ readonly data: F }>): Promise<F[]> {
  const rows: F[] = [];
  for await (const { data } of range) rows.push(data);
  return rows;
}

const namesOf = async (rows: Rows<Json, Named, readonly ["name"]>) =>
  (await rowDataOf(rows.range([]))).map(({ name }) => name);

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
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("holds a row once, however many objects give it", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { names: ["a"], n: 1 }), encodeObject(note, { names: ["a", "a"], n: 2 })],
      blobs: schemas,
    });
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
  });

  describe("in the order of some fields of its rows", () => {
    const entry = schema("Entry", { name: string(), n: optional(integer()), of: optional(link()) });
    type EntryData = DataOf<typeof entry>;

    async function rowsOf<const By extends FieldNames<EntryData>>(by: By, entries: readonly EntryData[]) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [encodeObject(note, {})], blobs: schemas });
      return scan(store, indexOver(selectedRecords(objectsOf(note)), entry, () => entries).orderedBy(...by));
    }

    it("gives the rows that hold a prefix, a field left out before any value and numbers in their order", async () => {
      const entries = [{ name: "b", n: 2 }, { name: "a", n: 10 }, { name: "a", n: 9 }, { name: "a" }, { name: "ab" }];
      const rows = await rowsOf(["name", "n"], entries);
      expect(await rowDataOf(rows.range([]))).toEqual([
        { name: "a" },
        { name: "a", n: 9 },
        { name: "a", n: 10 },
        { name: "ab" },
        { name: "b", n: 2 },
      ]);
      expect(await rowDataOf(rows.range(["a"]))).toEqual([{ name: "a" }, { name: "a", n: 9 }, { name: "a", n: 10 }]);
      expect(await rowDataOf(rows.range(["a", 10]))).toEqual([{ name: "a", n: 10 }]);
      expect(await rowDataOf(rows.range(["a", undefined]))).toEqual([{ name: "a" }]);
      expect(await rowDataOf(rows.range(["c"]))).toEqual([]);
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
      expect(await rowDataOf(rows.range([]))).toEqual(expectedRows);
      expect(await rowDataOf(rows.range([{ $link: links[1] as Link<unknown> }]))).toEqual(expectedRows.slice(2, 4));
    });

    it.each(["constructor", "__proto__"])(
      "puts a row that leaves out a field named %s before those that hold one",
      async (field) => {
        const labeled = schema("Labeled", { id: string(), [field]: optional(string()) });
        const store = new Store(json, new MemoryBackend());
        await store.write({ records: [encodeObject(note, {})], blobs: schemas });
        const entries = [{ id: "with", [field]: "a" }, { id: "without" }];
        const rows = await scan(
          store,
          indexOver(selectedRecords(objectsOf(note)), labeled, () => entries).orderedBy(field),
        );
        expect((await rowDataOf(rows.range([]))).map(({ id }) => id)).toEqual(["without", "with"]);
        // @ts-expect-error: a field whose name is not a literal is typed as one every row holds
        expect((await rowDataOf(rows.range([undefined]))).map(({ id }) => id)).toEqual(["without"]);
      },
    );

    it("takes as a prefix any start of its fields, of the types they hold", async () => {
      const rows = await rowsOf(["name", "n"], [{ name: "a", n: 1 }]);
      expect(await rowDataOf(rows.range(["a", 1]))).toEqual([{ name: "a", n: 1 }]);
      // @ts-expect-error: a name is a string
      expect(await rowDataOf(rows.range([1]))).toEqual([]);
      // @ts-expect-error: `of` does not order these rows
      expect(await rowDataOf(rows.range(["a", 1, { $link: note.link }]))).toEqual([]);
    });
  });

  it("gives rows that depend on an object's closure, read from the store as they are needed", async () => {
    const { signatures, publish } = loadIdentity([ed25519]);
    const signed = schema("Signed", { signer: link(), object: link() });
    const bySigner = indexOver(selectedRecords(objectsOf(signatures.schema)), signed, async function* (object, reader) {
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
    expect(await rowDataOf((await scan(store, bySigner)).range([]))).toEqual(expectedRows);
  });

  it("holds the rows of each index that it is a union of, each row once", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { names: ["a", "b"] }), encodeObject(tag, { names: ["b", "c"] })],
      blobs: schemas,
    });
    const byNoteOrTag = noteNames.union(indexOver(selectedRecords(objectsOf(tag)), named, namedOf)).orderedBy("name");
    expect(await namesOf(await scan(store, byNoteOrTag))).toEqual(["a", "b", "c"]);
  });

  it("holds no rows of a record that its selection leaves out", async () => {
    const namedNotes = new SelectionBySchema(note, ({ data }) => data.name);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, { name: "a" }), encodeObject(note, { names: [] })],
      blobs: schemas,
    });
    expect(
      await namesOf(
        await scan(store, indexOver(selectedRecords(namedNotes), named, (name) => [{ name }]).orderedBy("name")),
      ),
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
    expect(
      await namesOf(await scan(store, indexOver(selectedRecords(noteOrTag), named, namedOf).orderedBy("name"))),
    ).toEqual(["a", "b"]);
  });

  it("hands each of two selections that take one record what that selection reads it as", async () => {
    const names = indexOver(selectedRecords(new SelectionBySchema(note, ({ data }) => data.name)), pair, (name) => [
      { key: "name", value: name },
    ]);
    const counts = indexOver(selectedRecords(new SelectionBySchema(note, ({ data }) => data.n)), pair, (n) => [
      { key: "n", value: String(n) },
    ]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { name: "a", n: 1 })], blobs: schemas });
    expect(await rowDataOf((await scan(store, names.union(counts).orderedBy("key", "value"))).range([]))).toEqual([
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
          .map((selection) => indexOver(selectedRecords(selection), named, (name) => [{ name }]))
          .reduce((a, b) => a.union(b))
          .orderedBy("name"),
      );
    const routedRows = await namesOf(await rowsOf([namedNotes, namedTags]));
    expect(routedRows).toEqual(["a", "b"]);
    expect(await namesOf(await rowsOf([plainSelectionOf(namedNotes), plainSelectionOf(namedTags)]))).toEqual(
      routedRows,
    );
    expect(await namesOf(await rowsOf([namedNotes, plainSelectionOf(namedTags)]))).toEqual(routedRows);
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
    const index = indexOver(selectedRecords(objectsOf(strict)), named, () => [{ name: "a" }]).union(
      indexOver(selectedRecords(objectsOf(strict)), named, () => [{ name: "b" }]),
      indexOver(selectedRecords(objectsOf(lax)), named, () => [{ name: "c" }]),
    );
    expect(await namesOf(await scan(store, index.orderedBy("name")))).toEqual(["a", "b", "c"]);
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
      indexOver(selectedRecords(selection), pair, (value) => [{ key, value }]);
    const rows = await scan(
      new Store(json, backendNoting(requestedLinks, backend)),
      nameAs("a", cardName)
        .union(nameAs("b", cardName), nameAs("b", plainSelectionOf(cardName)))
        .orderedBy("key", "value"),
    );
    expect(await rowDataOf(rows.range([]))).toEqual([
      { key: "a", value: "Alice" },
      { key: "b", value: "Alice" },
    ]);
    expect(requestedLinks.filter((link) => link === card.link)).toHaveLength(1);
    expect(requestedLinks.filter((link) => link === record.link)).toHaveLength(1);
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
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
  });
});

describe("an index whose rows give none of what does not read as they expect", () => {
  const about = encodeObject(note, { names: ["a"] });
  const record = encodeObject(note, { about: { $link: about.link } });
  const byAbout = indexOver(selectedRecords(objectsOf(note)), named, async function* ({ data }, reader) {
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
    expect(await namesOf(await scan(store, byAbout))).toEqual(["a"]);
  });

  it("is not filled when the store does not hold a blob of a record's closure", async () => {
    const store = await storeGiving({ get: async () => undefined });
    await expect(scan(store, byAbout)).rejects.toThrow(
      `the store lists ${record.link} but does not hold ${about.link} of its closure`,
    );
  });
});

describe("an index that fails on something it reads", () => {
  const [unreadable, readable] = [encodeObject(note, { names: ["unreadable"] }), encodeObject(note, { names: ["a"] })];
  const readError = new Error("does not read");
  const readableNamedOf = (object: { readonly data: Entry }) => {
    const rows = namedOf(object);
    if (rows[0]?.name === "unreadable") throw readError;
    return rows;
  };
  const readableNames: NameIndex = indexOver(selectedRecords(objectsOf(note)), named, readableNamedOf);
  const byReadableName = readableNames.orderedBy("name");
  const upperNamesOf = (index: NameIndex): NameIndex =>
    indexOver(index, named, ({ data }) => [{ name: data.name.toUpperCase() }]);
  /** An index that reads `index` by two indexes over it, each a source of its own. */
  const byEitherNameOf = (index: NameIndex) => {
    const markedNames: NameIndex = indexOver(index, named, ({ data }) => [{ name: `${data.name}!` }]);
    return indexOver(upperNamesOf(index), named, ({ data }) => [data])
      .union(indexOver(markedNames, named, ({ data }) => [data]))
      .orderedBy("name");
  };

  async function storeOf(...records: readonly { readonly bytes: Uint8Array }[]): Promise<Store> {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records, blobs: schemas });
    return store;
  }

  it("gives the rows of what else it reads, and lists what it failed on with the error", async () => {
    const rows = await scan(await storeOf(unreadable, readable), byReadableName, { throwsOnFailure: false });
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
  });

  it("makes a scan throw the error of its first failure when it reads only records, unless the scan is told not to", async () => {
    const store = await storeOf(unreadable, readable);
    await expect(scan(store, byReadableName)).rejects.toBe(readError);
    await expect(scan(store, byReadableName, { throwsOnFailure: true })).rejects.toBe(readError);
    expect((await scan(store, byReadableName, { throwsOnFailure: false })).failures).toHaveLength(1);
  });

  it.each<[string, NameIndex, string]>([
    [
      "its selection throws",
      indexOver(selectedRecords(new SelectionBySchema(note, readableNamedOf)), named, (rows) => rows),
      "does not read",
    ],
    [
      "the data of a row does not fit its schema",
      indexOver(selectedRecords(objectsOf(note)), named, (object) =>
        object.data.names?.[0] === "unreadable" ? [{ name: 1 as unknown as string }] : namedOf(object),
      ),
      "#/name: not a string",
    ],
  ])("fails on a record when %s", async (_, index, message) => {
    const store = await storeOf(unreadable, readable);
    await expect(scan(store, index.orderedBy("name"))).rejects.toThrow(message);
    const rows = await scan(store, index.orderedBy("name"), { throwsOnFailure: false });
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([unreadable.link]);
  });

  it("keeps no row that its rows gave of something before they threw on it", async () => {
    const index = indexOver(selectedRecords(objectsOf(note)), named, function* (object) {
      yield* namedOf(object);
      readableNamedOf(object);
    });
    const rows = await scan(await storeOf(unreadable, readable), index.orderedBy("name"), { throwsOnFailure: false });
    expect(await namesOf(rows)).toEqual(["a"]);
  });

  it("does not read again what it failed on, and reads what is listed after it", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [readable], blobs: schemas });
    expect((await scan(store, byReadableName)).failures).toEqual([]);
    await store.write({ records: [unreadable] });
    expect((await scan(store, byReadableName, { throwsOnFailure: false })).failures).toHaveLength(1);
    requestedLinks.length = 0;
    await store.write({ records: [encodeObject(note, { names: ["b"] })] });
    await expect(scan(store, byReadableName)).rejects.toBe(readError);
    const rows = await scan(store, byReadableName, { throwsOnFailure: false });
    expect(await namesOf(rows)).toEqual(["a", "b"]);
    expect(rows.failures).toHaveLength(1);
    expect(requestedLinks).not.toContain(unreadable.link);
  });

  it("lists no failure for what its rows threw because the store failed, and a later scan reads that again", async () => {
    const about = encodeObject(note, { names: ["a"] });
    const record = encodeObject(note, { about: { $link: about.link } });
    const byAbout = indexOver(selectedRecords(objectsOf(note)), named, async function* ({ data }, reader) {
      if (data.about !== undefined) yield* namedOf(await readObject(reader, data.about.$link, note));
    }).orderedBy("name");
    const backend = new MemoryBackend();
    const diskError = new Error("the disk is gone");
    let isGone = false;
    const store = new Store(json, {
      ...backendNoting([], backend),
      get: (link) => (isGone && link === about.link ? Promise.reject(diskError) : backend.get(link)),
    });
    await store.write({ records: [record], blobs: [about.bytes, ...schemas] });
    isGone = true;
    await expect(scan(store, byAbout, { throwsOnFailure: false })).rejects.toBe(diskError);
    isGone = false;
    const rows = await scan(store, byAbout);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([]);
  });

  it("lists, on a staged batch, what it failed on of the batch, which its store does not keep", async () => {
    const store = await storeOf(readable);
    const stagedStore = await store.stage({ records: [unreadable] });
    const rows = await scan(stagedStore, byReadableName, { throwsOnFailure: false });
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    expect((await scan(store, byReadableName)).failures).toEqual([]);
  });

  it("lists, on a staged batch, one failure for a record that the batch lists twice, as its store does once the batch is written", async () => {
    const store = new Store(json, new MemoryBackend());
    const stagedStore = await store.stage({ records: [unreadable, unreadable, readable], blobs: schemas });
    const failures = [{ item: unreadable.link, error: readError }];
    const stagedRows = await scan(stagedStore, byReadableName, { throwsOnFailure: false });
    expect(await namesOf(stagedRows)).toEqual(["a"]);
    expect(stagedRows.failures).toEqual(failures);
    await stagedStore.commit();
    expect((await scan(store, byReadableName, { throwsOnFailure: false })).failures).toEqual(failures);
    expect((await scan(stagedStore, byReadableName, { throwsOnFailure: false })).failures).toEqual(failures);
  });

  it("lists, on a staged batch, no failure again for a record that its store lists already", async () => {
    const store = await storeOf(unreadable, readable);
    const rows = await scan(store, byReadableName, { throwsOnFailure: false });
    const stagedStore = await store.stage({ records: [unreadable] });
    expect(await scan(stagedStore, byReadableName, { throwsOnFailure: false })).toBe(rows);
  });

  describe("read by another index", () => {
    it("is among the failures of that index, which is scanned as it is", async () => {
      const store = await storeOf(unreadable, readable);
      const byUpperName = upperNamesOf(readableNames).orderedBy("name");
      await expect(scan(store, byUpperName)).rejects.toBe(readError);
      const rows = await scan(store, byUpperName, { throwsOnFailure: false });
      expect(await namesOf(rows)).toEqual(["A"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    });

    it("is listed once among the failures of an index that reads it by two indexes", async () => {
      const byEitherName = byEitherNameOf(readableNames);
      const rows = await scan(await storeOf(unreadable, readable), byEitherName, { throwsOnFailure: false });
      expect(await namesOf(rows)).toEqual(["A", "a!"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    });

    it("is read once on a staged batch for an index that reads it by two indexes, with each failure listed once", async () => {
      const readNames: string[] = [];
      const notedNames: NameIndex = indexOver(selectedRecords(objectsOf(note)), named, (object) => {
        readNames.push(...(object.data.names ?? []));
        return readableNamedOf(object);
      });
      const byEitherName = byEitherNameOf(notedNames);
      const stagedStore = await (await storeOf()).stage({ records: [unreadable, readable], blobs: schemas });
      const rows = await scan(stagedStore, byEitherName, { throwsOnFailure: false });
      expect(await namesOf(rows)).toEqual(["A", "a!"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
      expect(readNames.sort()).toEqual(["a", "unreadable"]);
    });

    it("gives that index, as a failure of its own, the row that its rows throw on", async () => {
      const store = await storeOf(unreadable, readable);
      const index = indexOver(noteNames, named, ({ data }) => {
        if (data.name === "unreadable") throw readError;
        return [data];
      });
      await expect(scan(store, index.orderedBy("name"))).rejects.toBe(readError);
      const rows = await scan(store, index.orderedBy("name"), { throwsOnFailure: false });
      expect(await namesOf(rows)).toEqual(["a"]);
      expect(rows.failures).toEqual([{ item: encodeObject(named, { name: "unreadable" }).link, error: readError }]);
      expect(await namesOf(await scan(store, byName))).toEqual(["a", "unreadable"]);
    });

    it("leaves a scan of that index to give its rows when this one reads blobs, unless the scan is told to throw", async () => {
      const store = await storeOf(encodeObject(tag, { names: ["unreadable"] }), encodeObject(tag, { names: ["a"] }));
      const tagNames: NameIndex = indexOver(selectedBlobs(objectsOf(tag)), named, readableNamedOf);
      const byUpperName = upperNamesOf(tagNames).orderedBy("name");
      const rows = await scan(store, byUpperName);
      expect(await namesOf(rows)).toEqual(["A"]);
      expect(rows.failures).toHaveLength(1);
      await expect(scan(store, byUpperName, { throwsOnFailure: true })).rejects.toBe(readError);
    });
  });
});

describe("an index scanned again from a store", () => {
  const [first, second] = [encodeObject(note, { names: ["a"] }), encodeObject(note, { names: ["b"] })];

  it("reads only the records listed since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
    await store.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).toContain(second.link);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("holds the rows of all the records for another index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first, encodeObject(tag, { names: ["t"] })], blobs: schemas });
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
    expect(
      await namesOf(await scan(store, indexOver(selectedRecords(objectsOf(tag)), named, namedOf).orderedBy("name"))),
    ).toEqual(["t"]);
  });

  it("takes in the records that another store on the same backend writes", async () => {
    const backend = new MemoryBackend();
    const [store, other] = [new Store(json, backend), new Store(json, backend)];
    await store.write({ records: [first], blobs: schemas });
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
    await other.write({ records: [second] });
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("reads each record once for scans that overlap", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    const scans = await Promise.all([scan(store, byName), scan(store, byName)]);
    for (const rows of scans) expect(await namesOf(rows)).toEqual(["a"]);
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
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("reads, on a staged batch, the batch's records on top of the rows its store keeps", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byName);
    requestedLinks.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect(await namesOf(await scan(stagedStore, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
    expect(await namesOf(await scan(store, byName))).toEqual(["a"]);
    await stagedStore.commit();
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("reads, on a private store, only the records written to it since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, backendNoting(requestedLinks, new MemoryBackend()));
    await privateStore.write({ records: [first], blobs: schemas });
    expect(await namesOf(await scan(privateStore, byName))).toEqual(["a"]);
    await privateStore.write({ records: [second] });
    requestedLinks.length = 0;
    expect(await namesOf(await scan(privateStore, byName))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
  });
});

describe("an index scanned in two orders", () => {
  const counted = schema("Counted", { name: string(), n: integer() });
  const countedNotes = indexOver(selectedRecords(objectsOf(note)), counted, ({ data: { name, n } }) =>
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
    expect(await rowDataOf((await scan(store, byCountedName)).range([]))).toEqual([
      { name: "a", n: 3 },
      { name: "b", n: 2 },
      { name: "c", n: 1 },
    ]);
    expect(await rowDataOf((await scan(store, byCount)).range([]))).toEqual([
      { name: "c", n: 1 },
      { name: "b", n: 2 },
      { name: "a", n: 3 },
    ]);
    expect(await rowDataOf((await scan(store, byCount)).range([2]))).toEqual([{ name: "b", n: 2 }]);
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
    expect((await rowDataOf((await scan(store, byCountedName)).range([]))).map(({ name }) => name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect((await rowDataOf((await scan(store, byCount)).range([]))).map(({ n }) => n)).toEqual([1, 2, 3]);
  });

  it("reads, on a staged batch, the batch's records once on top of the rows its store keeps in each order", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
    await store.write({ records: [first], blobs: schemas });
    await scan(store, byCountedName);
    requestedLinks.length = 0;
    const stagedStore = await store.stage({ records: [second] });
    expect((await rowDataOf((await scan(stagedStore, byCount)).range([]))).map(({ n }) => n)).toEqual([1, 3]);
    expect(requestedLinks).not.toContain(first.link);
    expect((await rowDataOf((await scan(store, byCount)).range([]))).map(({ n }) => n)).toEqual([3]);
  });
});

describe("an index over blobs", () => {
  const tagNames: NameIndex = indexOver(selectedBlobs(objectsOf(tag)), named, namedOf);
  const byTagName = tagNames.orderedBy("name");
  const carrying = (...blobs: readonly Uint8Array[]) =>
    encodeObject(note, { attachments: blobs.map((blob) => ({ $link: linkOf(blob) })) });

  it("holds the rows of a blob of its schema that no record is, however deep in a record's closure", async () => {
    const deep = encodeObject(tag, { names: ["deep"] });
    const near = encodeObject(tag, { names: ["near"], of: { $link: deep.link } });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(near.bytes)], blobs: [deep.bytes, near.bytes, ...schemas] });
    expect(await namesOf(await scan(store, byTagName))).toEqual(["deep", "near"]);
    expect(
      await namesOf(await scan(store, indexOver(selectedRecords(objectsOf(tag)), named, namedOf).orderedBy("name"))),
    ).toEqual([]);
  });

  it("holds the rows of a record of its schema, and of no blob of another schema", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { names: ["tag"] }), encodeObject(note, { names: ["note"] })],
      blobs: schemas,
    });
    expect(await namesOf(await scan(store, byTagName))).toEqual(["tag"]);
  });

  it("holds no rows of a blob of the batch that the write did not keep", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(note, {})],
      blobs: [encodeObject(tag, { names: ["outside the closure"] }).bytes, ...schemas],
    });
    expect(await namesOf(await scan(store, byTagName))).toEqual([]);
  });

  it("holds no rows of what its selection leaves out", async () => {
    const namedTags = new SelectionBySchema(tag, ({ data }) => data.name);
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [encodeObject(tag, { name: "a" }), encodeObject(tag, {})],
      blobs: schemas,
    });
    expect(
      await namesOf(
        await scan(store, indexOver(selectedBlobs(namedTags), named, (name) => [{ name }]).orderedBy("name")),
      ),
    ).toEqual(["a"]);
  });

  it.each([
    ["bytes that are not JSON", new Uint8Array([0xff, 0xfe])],
    ["text", new TextEncoder().encode("an image")],
    ["JSON that is not an object", json.encode([1, 2])],
    ["JSON that names no schema", json.encode({ names: ["no schema"] })],
  ])("holds no rows of %s, which it does not fail on", async (_, blob) => {
    const other = encodeObject(tag, { names: ["other"] });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [carrying(blob, other.bytes)], blobs: [blob, other.bytes, ...schemas] });
    const rows = await scan(store, byTagName);
    expect(await namesOf(rows)).toEqual(["other"]);
    expect(rows.failures).toEqual([]);
  });

  it("fails on a blob that names its schema and does not fit it, and still gives the rows of the other blobs", async () => {
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
    const rows = await scan(store, indexOver(selectedBlobs(objectsOf(strict)), named, namedOf).orderedBy("name"));
    expect(await namesOf(rows)).toEqual(["fitting"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([misfit.link]);
  });

  describe("whose selection or rows throw on a blob", () => {
    const [unreadable, readable] = [encodeObject(tag, { names: ["unreadable"] }), encodeObject(tag, { names: ["a"] })];
    const readableNamedOf = (object: { readonly data: Entry }) => {
      const rows = namedOf(object);
      if (rows[0]?.name === "unreadable") throw new Error("does not read");
      return rows;
    };

    async function rowsOf(index: NameIndex, options?: { readonly throwsOnFailure: boolean }) {
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [unreadable, readable], blobs: schemas });
      return scan(store, index.orderedBy("name"), options);
    }

    it.each<[string, NameIndex]>([
      [
        "selection throws",
        indexOver(selectedBlobs(new SelectionBySchema(tag, readableNamedOf)), named, (rows) => rows),
      ],
      ["rows throw", indexOver(selectedBlobs(objectsOf(tag)), named, readableNamedOf)],
    ])("fails on the blob its %s on, and still gives the rows of the other blobs", async (_, index) => {
      const rows = await rowsOf(index);
      expect(await namesOf(rows)).toEqual(["a"]);
      expect(rows.failures.map(({ item }) => item)).toEqual([unreadable.link]);
      await expect(rowsOf(index, { throwsOnFailure: true })).rejects.toThrow("does not read");
    });

    it("keeps no row that its rows gave of the blob before they threw", async () => {
      const index = indexOver(selectedBlobs(objectsOf(tag)), named, function* (object) {
        yield* namedOf(object);
        readableNamedOf(object);
      });
      expect(await namesOf(await rowsOf(index))).toEqual(["a"]);
    });

    it("fails once, on a staged batch, on a blob that its store holds already", async () => {
      const index = indexOver(selectedBlobs(objectsOf(tag)), named, readableNamedOf).orderedBy("name");
      const carrierNamed = (name: string) => encodeObject(note, { names: [name], of: { $link: unreadable.link } });
      const [first, second] = [carrierNamed("first"), carrierNamed("second")];
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [first], blobs: [unreadable.bytes, ...schemas] });
      const stagedStore = await store.stage({ records: [second, readable], blobs: [unreadable.bytes] });
      const stagedRows = await scan(stagedStore, index);
      expect(await namesOf(stagedRows)).toEqual(["a"]);
      expect(stagedRows.failures.map(({ item }) => item)).toEqual([unreadable.link]);
      await stagedStore.commit();
      expect((await scan(store, index)).failures).toEqual(stagedRows.failures);
    });
  });

  it("fails on a blob when the data of a row of it does not fit the schema of the index", async () => {
    const misfit = encodeObject(tag, { n: 1 });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(tag, { names: ["a"] }), misfit], blobs: schemas });
    const index = indexOver(selectedBlobs(objectsOf(tag)), named, (object) => [
      ...namedOf(object),
      ...(object.data.n === undefined ? [] : [{ name: object.data.n as unknown as string }]),
    ]);
    const rows = await scan(store, index.orderedBy("name"));
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([misfit.link]);
  });

  it("is not filled from something else with a `get` and `records`, which still fills an index of records", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { names: ["a"] })], blobs: schemas });
    const standIn = { get: <T>(link: Link<T>) => store.get(link), records: () => store.records() };
    expect(await namesOf(await scan(standIn, byName))).toEqual(["a"]);
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
      expect(await namesOf(await scan(store, byTagName))).toEqual(["nested", "other", "reaching"]);
    });

    const linkedFrom = (data: Entry) => data.of?.$link;

    it.each<[string, NameIndex]>([
      [
        "its selection reads and catches",
        indexOver(
          selectedBlobs(
            new SelectionBySchema(tag, async ({ data }, reader) => {
              const of = linkedFrom(data);
              if (of === undefined) return undefined;
              try {
                return namedOf(await readObject(reader, of, tag));
              } catch {
                return undefined;
              }
            }),
          ),
          named,
          (rows) => rows,
        ),
      ],
      [
        "its rows read",
        indexOver(selectedBlobs(objectsOf(tag)), named, async function* ({ data }, reader) {
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
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x"]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x", "y"]);
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
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("takes in the blobs that another store on the same backend writes", async () => {
      const backend = new MemoryBackend();
      const [store, other] = [new Store(json, backend), new Store(json, backend)];
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x"]);
      await other.write({ records: [second], blobs: [secondTag.bytes] });
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x", "y"]);
    });

    it("goes on with records and with blobs each from where it left off, in a union with an index of records", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      const union = noteNames.union(tagNames).orderedBy("name");
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      expect(await namesOf(await scan(store, union))).toEqual(["a", "x"]);
      await store.write({ records: [second], blobs: [secondTag.bytes] });
      requestedLinks.length = 0;
      expect(await namesOf(await scan(store, union))).toEqual(["a", "b", "x", "y"]);
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
      expect(await namesOf(await scan(stagedStore, byTagName))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x"]);
      await stagedStore.commit();
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x", "y"]);
    });

    it("reads, on a private store, only the blobs kept in it", async () => {
      const store = new Store(json, new MemoryBackend());
      const privateStore = new PrivateStore(store, new MemoryBackend());
      await store.write({ records: [first], blobs: [firstTag.bytes, ...schemas] });
      const kept = encodeObject(note, { of: { $link: secondTag.link }, shared: { $link: firstTag.link } });
      await privateStore.write({ records: [kept], blobs: [secondTag.bytes] });
      expect(await namesOf(await scan(privateStore, byTagName))).toEqual(["y"]);
      expect(await namesOf(await scan(store, byTagName))).toEqual(["x"]);
    });
  });
});

describe("an index over another index", () => {
  const upperNames: NameIndex = indexOver(noteNames, named, ({ data }) => [{ name: data.name.toUpperCase() }]);
  const byUpperName = upperNames.orderedBy("name");
  const [first, second] = [encodeObject(note, { names: ["a"] }), encodeObject(note, { names: ["b"] })];

  it("holds the rows that its rows give of each row of the other index", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { names: ["b", "a"] })], blobs: schemas });
    expect(await namesOf(await scan(store, byUpperName))).toEqual(["A", "B"]);
    expect(await namesOf(await scan(store, byName))).toEqual(["a", "b"]);
  });

  it("holds no rows of an object of the schema of those rows that the store holds", async () => {
    const [listed, unlisted] = [encodeObject(named, { name: "listed" }), encodeObject(named, { name: "unlisted" })];
    const store = new Store(json, new MemoryBackend());
    await store.write({
      records: [first, listed, encodeObject(note, { of: { $link: unlisted.link } })],
      blobs: [unlisted.bytes, named.bytes, ...schemas],
    });
    expect(await namesOf(await scan(store, byUpperName))).toEqual(["A"]);
  });

  it("leaves its rows and those it reads out of the store, and out of an index over the blobs of their schema", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first], blobs: [named.bytes, ...schemas] });
    const rows = [await scan(store, byName), await scan(store, byUpperName)];
    for (const each of rows) for await (const { link } of each.range([])) expect(await store.get(link)).toBeUndefined();
    const namedBlobs = indexOver(selectedBlobs(objectsOf(named)), named, ({ data }) => [data]);
    expect(await namesOf(await scan(store, namedBlobs.orderedBy("name")))).toEqual([]);
  });

  it("reads through the indexes it is over: their rows by link, and what those link to from the store", async () => {
    const traced = schema("Traced", { name: string(), from: link() });
    const tracedNotes = indexOver(selectedRecords(plainSelectionOf(objectsOf(note))), traced, ({ link, data }) =>
      (data.names ?? []).map((name) => ({ name, from: { $link: link } })),
    );
    const tracedRows = indexOver(tracedNotes, traced, ({ link, data }) => [
      { name: data.name.toUpperCase(), from: { $link: link } },
    ]);
    const sources = indexOver(tracedRows, named, async function* ({ data }, reader) {
      const row = await readObject(reader, data.from.$link, traced);
      const record = await readObject(reader, row.data.from.$link, note);
      yield { name: `${data.name} from ${row.data.name} of ${record.data.n}` };
    });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [encodeObject(note, { names: ["a", "b"], n: 1 })], blobs: schemas });
    expect(await namesOf(await scan(store, sources.orderedBy("name")))).toEqual(["A from a of 1", "B from b of 1"]);
  });

  it("reads the closure of a row through the indexes it is over, with the schemas of their rows, which the store does not hold", async () => {
    const traced = schema("Traced", { name: string(), from: link() });
    const retraced = schema("Retraced", { name: string(), from: link() });
    const tracedNotes = indexOver(selectedRecords(objectsOf(note)), traced, ({ link, data }) =>
      (data.names ?? []).map((name) => ({ name, from: { $link: link } })),
    );
    const retracedRows = indexOver(tracedNotes, retraced, ({ link, data }) => [
      { name: data.name.toUpperCase(), from: { $link: link } },
    ]);
    const closure = new Set<Link<unknown>>();
    const closures = indexOver(retracedRows, named, async function* ({ link, data }, reader) {
      const pending: Link<unknown>[] = [link];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (closure.has(next)) continue;
        closure.add(next);
        const bytes = await reader.get(next);
        if (bytes !== undefined) pending.push(...json.links(json.decode(bytes)));
      }
      yield { name: data.name };
    });
    const tracedRow = encodeObject(traced, { name: "a", from: { $link: first.link } });
    const retracedRow = encodeObject(retraced, { name: "A", from: { $link: tracedRow.link } });
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first], blobs: schemas });
    expect(await namesOf(await scan(store, closures.orderedBy("name")))).toEqual(["A"]);
    expect(closure).toEqual(
      new Set([retracedRow.link, retraced.link, tracedRow.link, traced.link, first.link, note.link]),
    );
    for (const { link } of [retraced, traced]) expect(await store.get(link)).toBeUndefined();
  });

  it("hands on a row of the other index as that index wrote it, validated once", async () => {
    let validationCount = 0;
    const namedCounting = encodeSchema(
      { title: "Named", fields: { name: string() } },
      {
        language: schemaValidator.language,
        compile(document) {
          const check = schemaValidator.compile(document);
          return (data) => {
            validationCount += 1;
            return check(data);
          };
        },
      },
    );
    const names = indexOver(selectedRecords(objectsOf(note)), namedCounting, namedOf);
    const upper: NameIndex = indexOver(names, named, ({ data }) => [{ name: `${data.name}`.toUpperCase() }]);
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first], blobs: schemas });
    expect(await namesOf(await scan(store, upper.orderedBy("name")))).toEqual(["A"]);
    expect(validationCount).toBe(1);
  });

  it("holds its rows with those of an index of records, in a union", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first, encodeObject(tag, { names: ["t"] })], blobs: schemas });
    const union = upperNames.union(indexOver(selectedRecords(objectsOf(tag)), named, namedOf)).orderedBy("name");
    expect(await namesOf(await scan(store, union))).toEqual(["A", "t"]);
  });

  it("is filled from something else with a `get` and `records`, unless an index it is over reads blobs", async () => {
    const store = new Store(json, new MemoryBackend());
    await store.write({ records: [first], blobs: schemas });
    const standIn = { get: <T>(link: Link<T>) => store.get(link), records: () => store.records() };
    expect(await namesOf(await scan(standIn, byUpperName))).toEqual(["A"]);
    const tagNames = indexOver(selectedBlobs(objectsOf(tag)), named, namedOf);
    const overBlobs = indexOver(tagNames, named, ({ data }) => [data]);
    await expect(scan(standIn, overBlobs.orderedBy("name"))).rejects.toThrow(
      "lists the blobs an index over blobs reads",
    );
  });

  describe("scanned again", () => {
    /** An index over `noteNames` that notes in `readNames` each row it reads. */
    const upperNamesNoting = (readNames: string[]): NameIndex =>
      indexOver(noteNames, named, ({ data }) => {
        readNames.push(data.name);
        return [{ name: data.name.toUpperCase() }];
      });

    it("reads only the rows that the other index gave since the last scan", async () => {
      const readNames: string[] = [];
      const index = upperNamesNoting(readNames).orderedBy("name");
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [first], blobs: schemas });
      expect(await namesOf(await scan(store, index))).toEqual(["A"]);
      await store.write({ records: [second] });
      expect(await namesOf(await scan(store, index))).toEqual(["A", "B"]);
      expect(readNames).toEqual(["a", "b"]);
    });

    it("reads each record once for the other index, an order of it and each index over it", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(json, backendNoting(requestedLinks, new MemoryBackend()));
      await store.write({ records: [first], blobs: schemas });
      await scan(store, byUpperName);
      await scan(store, byName);
      await scan(store, upperNamesNoting([]).orderedBy("name"));
      expect(requestedLinks.filter((link) => link === first.link)).toHaveLength(1);
    });

    it("reads, on a staged batch, the rows that the other index gives of the batch on top of those its store keeps", async () => {
      const readNames: string[] = [];
      const index = upperNamesNoting(readNames).orderedBy("name");
      const store = new Store(json, new MemoryBackend());
      await store.write({ records: [first], blobs: schemas });
      await scan(store, index);
      const stagedStore = await store.stage({ records: [second] });
      expect(await namesOf(await scan(stagedStore, index))).toEqual(["A", "B"]);
      expect(readNames).toEqual(["a", "b"]);
      expect(await namesOf(await scan(store, index))).toEqual(["A"]);
      await stagedStore.commit();
      expect(await namesOf(await scan(store, index))).toEqual(["A", "B"]);
    });

    it("reads, on a private store, the rows that the other index gives of the records written to it", async () => {
      const store = new Store(json, new MemoryBackend());
      const privateStore = new PrivateStore(store, new MemoryBackend());
      await store.write({ records: [first], blobs: schemas });
      await privateStore.write({ records: [second] });
      expect(await namesOf(await scan(privateStore, byUpperName))).toEqual(["B"]);
      expect(await namesOf(await scan(store, byUpperName))).toEqual(["A"]);
    });
  });
});
