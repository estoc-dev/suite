import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  objectsOf,
  readObject,
  rootSchema,
  type Schema,
  type Selection,
  SelectionBySchema,
  type ValueMap,
} from "@estoc/object";
import { array, type DataOf, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, test, vi } from "vitest";
import {
  type Backend,
  type Batch,
  type FieldNames,
  heldBlobs,
  type Index,
  indexOver,
  MemoryBackend,
  type Rows,
  Store,
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
const schemas = [note, tag].flatMap(({ blobs }) => blobs);
const named = schema("Named", { name: string() });
type Named = DataOf<typeof named>;
type NameIndex = Index<Named>;
const namedOf = ({ data }: { readonly data: Entry }): Named[] => (data.names ?? []).map((name) => ({ name }));

const noteNames: NameIndex = indexOver(selectedRecords(objectsOf(note)), named, namedOf);

const pair = schema("Pair", { key: string(), value: string() });

/** A selection that reads recorded objects as `selection` does, without a schema to route them by. */
const plainSelectionOf = <T>(selection: Selection<T>): Selection<T> => ({
  read: (link, reader) => selection.read(link, reader),
});

async function rowDataOf<F>(range: AsyncIterable<{ readonly data: F }>): Promise<F[]> {
  const rows: F[] = [];
  for await (const { data } of range) rows.push(data);
  return rows;
}

const namesOf = async (rows: Rows<Named>) =>
  (await rowDataOf(rows.orderedBy("name").range([]))).map(({ name }) => name);

const backendNoting = (requestedLinks: Link<unknown>[], backend: Backend): Backend => ({
  get: (link) => {
    requestedLinks.push(link);
    return backend.get(link);
  },
  has: (link) => backend.has(link),
  put: (blobs) => backend.put(blobs),
  blobs: (start) => backend.blobs(start),
});

const newStore = (backend: Backend = new MemoryBackend()) => new Store(backend);

interface KeptObject {
  readonly link: Link<EncodedObject>;
  readonly bytes: Uint8Array;
}

/** The batch that keeps `objects`, with those of `blobs` in their closures. */
const batchOf = (objects: readonly KeptObject[], blobs: Iterable<Uint8Array> = []): Batch => ({
  roots: objects.map(({ link }) => link),
  blobs: [...objects.map(({ bytes }) => bytes), ...blobs],
});

/** Lists the records first, so that a count taken after it is of what an index reads. */
async function listRecordsOf(store: Store): Promise<void> {
  for await (const _ of store.records());
}

/** An object that nothing has decoded or validated yet, as one that another program wrote. */
function writtenByHand(to: Schema, data: ValueMap): KeptObject {
  const bytes = objectFormat.encode(new ObjectValue(to.link, data));
  return { link: linkOf(bytes), bytes };
}

async function recordIn(store: Store, objects: readonly KeptObject[], blobs?: Iterable<Uint8Array>): Promise<void> {
  await store.record({ statements: objects.map(({ link }) => link), blobs: batchOf(objects, blobs).blobs });
}

describe("an index over records", () => {
  it("holds the rows of the objects that its records link to, of the schemas it reads", async () => {
    const store = newStore();
    const unlistedNote = encodeObject(note, { names: ["unlisted"] });
    await recordIn(
      store,
      [
        encodeObject(note, { names: ["b", "a"] }),
        encodeObject(tag, { names: ["tag"], of: new LinkValue(unlistedNote.link) }),
      ],
      [unlistedNote.bytes, ...schemas],
    );
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "b"]);
  });

  it("holds a row once, however many objects give it", async () => {
    const store = newStore();
    await recordIn(
      store,
      [encodeObject(note, { names: ["a"], n: 1 }), encodeObject(note, { names: ["a", "a"], n: 2 })],
      schemas,
    );
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a"]);
  });

  describe("with its rows ordered by some of their fields", () => {
    const entry = schema("Entry", { name: string(), n: optional(integer()), of: optional(link()) });
    type EntryData = DataOf<typeof entry>;

    async function rowsOf<const By extends FieldNames<EntryData>>(by: By, entries: readonly EntryData[]) {
      const store = newStore();
      await recordIn(store, [encodeObject(note, {})], schemas);
      return (await store.scan(indexOver(selectedRecords(objectsOf(note)), entry, () => entries))).orderedBy(...by);
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
      const entries = links.flatMap((link) => ["b", "a"].map((name) => ({ name, of: new LinkValue(link) })));
      const rows = await rowsOf(["of"], entries);
      const expectedRows = links.flatMap((of) =>
        entries
          .filter((each) => each.of.link === of)
          .map((each) => encodeObject(entry, each))
          .sort((a, b) => (a.link < b.link ? -1 : 1))
          .map(({ data }) => data),
      );
      expect(await rowDataOf(rows.range([]))).toEqual(expectedRows);
      expect(await rowDataOf(rows.range([new LinkValue(links[1] as Link<unknown>)]))).toEqual(expectedRows.slice(2, 4));
    });

    it.each(["constructor", "__proto__"])(
      "puts a row that leaves out a field named %s before those that hold one",
      async (field) => {
        const labeled = schema("Labeled", { id: string(), [field]: optional(string()) });
        const store = newStore();
        await recordIn(store, [encodeObject(note, {})], schemas);
        const entries = [{ id: "with", [field]: "a" }, { id: "without" }];
        const rows = (await store.scan(indexOver(selectedRecords(objectsOf(note)), labeled, () => entries))).orderedBy(
          field,
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
      expect(await rowDataOf(rows.range(["a", 1, new LinkValue(note.link)]))).toEqual([]);
    });
  });

  it("gives rows that depend on an object's closure, read from the store as they are needed", async () => {
    const cardNames = indexOver(selectedRecords(objectsOf(note)), named, async function* ({ data }, reader) {
      if (data.card === undefined) return;
      const { name } = (await readObject(reader, data.card.link, tag)).data;
      if (name !== undefined) yield { name };
    });
    const cards = ["Bob", "Alice"].map((name) => encodeObject(tag, { name }));
    const store = newStore();
    await recordIn(
      store,
      cards.map(({ link }) => encodeObject(note, { card: new LinkValue(link) })),
      [...cards.map(({ bytes }) => bytes), ...schemas],
    );
    expect(await namesOf(await store.scan(cardNames))).toEqual(["Alice", "Bob"]);
  });

  it("holds the rows of each index that it is a union of, each row once", async () => {
    const store = newStore();
    await recordIn(
      store,
      [encodeObject(note, { names: ["a", "b"] }), encodeObject(tag, { names: ["b", "c"] })],
      schemas,
    );
    const noteOrTagNames = noteNames.union(indexOver(selectedRecords(objectsOf(tag)), named, namedOf));
    expect(await namesOf(await store.scan(noteOrTagNames))).toEqual(["a", "b", "c"]);
  });

  it("holds no rows of a recorded object that its selection leaves out", async () => {
    const namedNotes = new SelectionBySchema(note, ({ data }) => data.name);
    const store = newStore();
    await recordIn(store, [encodeObject(note, { name: "a" }), encodeObject(note, { names: [] })], schemas);
    expect(
      await namesOf(await store.scan(indexOver(selectedRecords(namedNotes), named, (name) => [{ name }]))),
    ).toEqual(["a"]);
  });

  it("takes recorded objects of several schemas in one selection", async () => {
    const noteOrTag: Selection<{ readonly data: Entry }> = {
      async read(link, reader) {
        return (await objectsOf(note).read(link, reader)) ?? (await objectsOf(tag).read(link, reader));
      },
    };
    const store = newStore();
    await recordIn(store, [encodeObject(note, { names: ["a"] }), encodeObject(tag, { names: ["b"] })], schemas);
    expect(await namesOf(await store.scan(indexOver(selectedRecords(noteOrTag), named, namedOf)))).toEqual(["a", "b"]);
  });

  it("hands each of two selections that take one recorded object what that selection reads it as", async () => {
    const names = indexOver(selectedRecords(new SelectionBySchema(note, ({ data }) => data.name)), pair, (name) => [
      { key: "name", value: name },
    ]);
    const counts = indexOver(selectedRecords(new SelectionBySchema(note, ({ data }) => data.n)), pair, (n) => [
      { key: "n", value: String(n) },
    ]);
    const store = newStore();
    await recordIn(store, [encodeObject(note, { name: "a", n: 1 })], schemas);
    expect(await rowDataOf((await store.scan(names.union(counts))).orderedBy("key", "value").range([]))).toEqual([
      { key: "n", value: "1" },
      { key: "name", value: "a" },
    ]);
  });

  it("gives the rows of a selection by schema that it gives of a selection reading each recorded object as that one does", async () => {
    const namedNotes = new SelectionBySchema(note, ({ data }) => data.name);
    const namedTags = new SelectionBySchema(tag, ({ data }) => data.name);
    const store = newStore();
    await recordIn(
      store,
      [encodeObject(note, { name: "a" }), encodeObject(note, {}), encodeObject(tag, { name: "b" })],
      schemas,
    );
    const rowsOf = (selections: Selection<string>[]) =>
      store.scan(
        selections
          .map((selection) => indexOver(selectedRecords(selection), named, (name) => [{ name }]))
          .reduce((a, b) => a.union(b)),
      );
    const routedRows = await namesOf(await rowsOf([namedNotes, namedTags]));
    expect(routedRows).toEqual(["a", "b"]);
    expect(await namesOf(await rowsOf([plainSelectionOf(namedNotes), plainSelectionOf(namedTags)]))).toEqual(
      routedRows,
    );
    expect(await namesOf(await rowsOf([namedNotes, plainSelectionOf(namedTags)]))).toEqual(routedRows);
  });

  it("validates a recorded object once for the selections by schema that read it", async () => {
    const noteSchema = schema("Note", fields);
    const validate = vi.spyOn(noteSchema, "validate");
    const store = newStore();
    await recordIn(store, [writtenByHand(note, { names: ["read by three selections"] })], schemas);
    const index = indexOver(selectedRecords(objectsOf(noteSchema)), named, () => [{ name: "a" }]).union(
      indexOver(selectedRecords(objectsOf(noteSchema)), named, () => [{ name: "b" }]),
      indexOver(selectedRecords(objectsOf(noteSchema)), named, () => [{ name: "c" }]),
    );
    expect(await namesOf(await store.scan(index))).toEqual(["a", "b", "c"]);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("reads a blob from the store once for a recorded object, the object among them, however many selections read it", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    const card = encodeObject(tag, { name: "Alice" });
    const record = encodeObject(note, { card: new LinkValue(card.link) });
    await recordIn(store, [record], [card.bytes, ...schemas]);
    await listRecordsOf(store);
    requestedLinks.length = 0;
    const cardName = new SelectionBySchema(note, async ({ data }, reader) => {
      if (data.card === undefined) return undefined;
      return (await readObject(reader, data.card.link, tag)).data.name;
    });
    const nameAs = (key: string, selection: Selection<string>) =>
      indexOver(selectedRecords(selection), pair, (value) => [{ key, value }]);
    const rows = await store.scan(
      nameAs("a", cardName).union(nameAs("b", cardName), nameAs("b", plainSelectionOf(cardName))),
    );
    expect(await rowDataOf(rows.orderedBy("key", "value").range([]))).toEqual([
      { key: "a", value: "Alice" },
      { key: "b", value: "Alice" },
    ]);
    expect(requestedLinks.filter((link) => link === card.link)).toHaveLength(1);
    expect(requestedLinks.filter((link) => link === record.link)).toHaveLength(1);
  });

  it.each([
    ["a schema it reads", note],
    ["a schema it does not read", tag],
  ])(
    "is not filled when the backend holds another blob under the link of a recorded object, of %s",
    async (_, schema) => {
      const backend = new MemoryBackend();
      const [listedObject, other] = [encodeObject(note, { names: ["a"] }), encodeObject(schema, { names: ["b"] })];
      await recordIn(newStore(backend), [listedObject, other], schemas);
      const swappedBackend: Backend = {
        get: (link) => backend.get(link === listedObject.link ? other.link : link),
        has: (link) => backend.has(link),
        put: (blobs) => backend.put(blobs),
        blobs: (start) => backend.blobs(start),
      };
      await expect(newStore(swappedBackend).scan(noteNames)).rejects.toThrow(`another blob under ${listedObject.link}`);
    },
  );
});

describe("an index whose rows give none of what does not read as they expect", () => {
  const about = encodeObject(note, { names: ["a"] });
  const record = encodeObject(note, { about: new LinkValue(about.link) });
  const aboutNamesCatching = (caughtErrors: unknown[]) =>
    indexOver(selectedRecords(objectsOf(note)), named, async function* ({ data }, reader) {
      const { about } = data;
      if (about === undefined) return;
      let aboutNames: readonly Named[];
      try {
        aboutNames = namedOf(await readObject(reader, about.link, note));
      } catch (error) {
        caughtErrors.push(error);
        return;
      }
      yield* aboutNames;
    });

  /** The Records are read before `about` fails, so the failure comes where the rows read it. */
  async function storeFailingToRead(readAbout: () => Promise<Uint8Array | undefined>) {
    const readOverride: { get?: () => Promise<Uint8Array | undefined> } = {};
    const backend = new (class extends MemoryBackend {
      override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
        return link === about.link && readOverride.get !== undefined ? readOverride.get() : super.get(link);
      }
    })();
    const store = newStore(backend);
    await recordIn(store, [record], [about.bytes, ...schemas]);
    await store.recordedStatements();
    readOverride.get = readAbout;
    return { store, readOverride };
  }

  it("is not filled when the store throws for a blob of a recorded object's closure, and a later scan reads the object", async () => {
    const readError = new Error("the disk is gone");
    const { store, readOverride } = await storeFailingToRead(() => Promise.reject(readError));
    const caughtErrors: unknown[] = [];
    const aboutNames = aboutNamesCatching(caughtErrors);
    await expect(store.scan(aboutNames)).rejects.toBe(readError);
    expect(caughtErrors).toEqual([readError]);
    delete readOverride.get;
    expect(await namesOf(await store.scan(aboutNames))).toEqual(["a"]);
  });

  it("is not filled when the store does not hold a blob of a recorded object's closure", async () => {
    const { store } = await storeFailingToRead(async () => undefined);
    const caughtErrors: unknown[] = [];
    await expect(store.scan(aboutNamesCatching(caughtErrors))).rejects.toThrow(
      `a scan reads ${record.link}, and the store does not hold ${about.link} of its closure`,
    );
    expect(caughtErrors).toHaveLength(1);
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
  const readableBlobNames = indexOver(selectedBlobs(objectsOf(note)), named, readableNamedOf);
  const upperNamesOf = (index: NameIndex): NameIndex =>
    indexOver(index, named, ({ data }) => [{ name: data.name.toUpperCase() }]);
  /** An index that reads `index` by two indexes over it, each a source of its own. */
  const eitherNamesOf = (index: NameIndex) => {
    const markedNames: NameIndex = indexOver(index, named, ({ data }) => [{ name: `${data.name}!` }]);
    return indexOver(upperNamesOf(index), named, ({ data }) => [data]).union(
      indexOver(markedNames, named, ({ data }) => [data]),
    );
  };

  async function storeRecording(...objects: readonly KeptObject[]) {
    const store = newStore();
    await recordIn(store, objects, schemas);
    return store;
  }

  it("gives the rows of what else it reads, and lists what it failed on with the error", async () => {
    const rows = await (await storeRecording(unreadable, readable)).scan(readableNames);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
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
  ])("fails on a recorded object when %s", async (_, index, message) => {
    const store = await storeRecording(unreadable, readable);
    const rows = await store.scan(index);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([unreadable.link]);
    expect(rows.failures.map(({ error }) => String(error))).toEqual([expect.stringContaining(message)]);
  });

  it("keeps no row that its rows gave of something before they threw on it", async () => {
    const index = indexOver(selectedRecords(objectsOf(note)), named, function* (object) {
      yield* namedOf(object);
      readableNamedOf(object);
    });
    const rows = await (await storeRecording(unreadable, readable)).scan(index);
    expect(await namesOf(rows)).toEqual(["a"]);
  });

  it("does not read again what it failed on, and reads what is listed after it", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    await recordIn(store, [readable], schemas);
    expect((await store.scan(readableNames)).failures).toEqual([]);
    await recordIn(store, [unreadable]);
    expect((await store.scan(readableNames)).failures).toHaveLength(1);
    requestedLinks.length = 0;
    await recordIn(store, [encodeObject(note, { names: ["b"] })]);
    const rows = await store.scan(readableNames);
    expect(await namesOf(rows)).toEqual(["a", "b"]);
    expect(rows.failures).toHaveLength(1);
    expect(requestedLinks).not.toContain(unreadable.link);
  });

  it("lists no failure for what its rows threw because the store failed, and a later scan reads that again", async () => {
    const about = encodeObject(note, { names: ["a"] });
    const record = encodeObject(note, { about: new LinkValue(about.link) });
    const aboutNames = indexOver(selectedRecords(objectsOf(note)), named, async function* ({ data }, reader) {
      if (data.about !== undefined) yield* namedOf(await readObject(reader, data.about.link, note));
    });
    const backend = new MemoryBackend();
    const diskError = new Error("the disk is gone");
    let isGone = false;
    const store = newStore({
      ...backendNoting([], backend),
      get: (link) => (isGone && link === about.link ? Promise.reject(diskError) : backend.get(link)),
    });
    await recordIn(store, [record], [about.bytes, ...schemas]);
    isGone = true;
    await expect(store.scan(aboutNames)).rejects.toBe(diskError);
    isGone = false;
    const rows = await store.scan(aboutNames);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([]);
  });

  it("lists, on a staged batch, what it failed on of the batch, which its store does not keep", async () => {
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([readable], schemas));
    const stagedStore = await store.stage(batchOf([unreadable]));
    const rows = await stagedStore.scan(readableBlobNames);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    expect((await store.scan(readableBlobNames)).failures).toEqual([]);
  });

  describe("read by another index", () => {
    it("is among the failures of that index, which is scanned as it is", async () => {
      const store = await storeRecording(unreadable, readable);
      const upperNames = upperNamesOf(readableNames);
      const rows = await store.scan(upperNames);
      expect(await namesOf(rows)).toEqual(["A"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    });

    it("is listed once among the failures of an index that reads it by two indexes", async () => {
      const eitherNames = eitherNamesOf(readableNames);
      const rows = await (await storeRecording(unreadable, readable)).scan(eitherNames);
      expect(await namesOf(rows)).toEqual(["A", "a!"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
    });

    it("is read once on a staged batch for an index that reads it by two indexes, with each failure listed once", async () => {
      const readNames: string[] = [];
      const notedNames: NameIndex = indexOver(selectedBlobs(objectsOf(note)), named, (object) => {
        readNames.push(...(object.data.names ?? []));
        return readableNamedOf(object);
      });
      const eitherNames = eitherNamesOf(notedNames);
      const stagedStore = await new Store(new MemoryBackend()).stage(batchOf([unreadable, readable], schemas));
      const rows = await stagedStore.scan(eitherNames);
      expect(await namesOf(rows)).toEqual(["A", "a!"]);
      expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
      expect(readNames.sort()).toEqual(["a", "unreadable"]);
    });

    it("gives that index, as a failure of its own, the row that its rows throw on", async () => {
      const store = await storeRecording(unreadable, readable);
      const index = indexOver(noteNames, named, ({ data }) => {
        if (data.name === "unreadable") throw readError;
        return [data];
      });
      const rows = await store.scan(index);
      expect(await namesOf(rows)).toEqual(["a"]);
      expect(rows.failures).toEqual([{ item: encodeObject(named, { name: "unreadable" }).link, error: readError }]);
      expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "unreadable"]);
    });
  });
});

describe("an index over records, scanned again", () => {
  const [first, second] = [encodeObject(note, { names: ["a"] }), encodeObject(note, { names: ["b"] })];

  it("reads only the objects recorded since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    await recordIn(store, [first], schemas);
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a"]);
    await recordIn(store, [second]);
    requestedLinks.length = 0;
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "b"]);
    expect(requestedLinks).toContain(second.link);
    expect(requestedLinks).not.toContain(first.link);
  });

  it("holds the rows of all the recorded objects for another index", async () => {
    const store = newStore();
    await recordIn(store, [first, encodeObject(tag, { names: ["t"] })], schemas);
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a"]);
    expect(await namesOf(await store.scan(indexOver(selectedRecords(objectsOf(tag)), named, namedOf)))).toEqual(["t"]);
  });

  it("takes in the objects that are recorded through another store on the same backend", async () => {
    const backend = new MemoryBackend();
    const [store, others] = [newStore(backend), newStore(backend)];
    await recordIn(store, [first], schemas);
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a"]);
    await recordIn(others, [second]);
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "b"]);
  });

  it("reads each recorded object once for scans that overlap", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    await recordIn(store, [first], schemas);
    await listRecordsOf(store);
    requestedLinks.length = 0;
    const scans = await Promise.all([store.scan(noteNames), store.scan(noteNames)]);
    for (const rows of scans) expect(await namesOf(rows)).toEqual(["a"]);
    expect(requestedLinks.filter((link) => link === first.link)).toHaveLength(1);
  });

  it("goes on from the last scan that went through, after one that fails", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const backend = backendNoting(requestedLinks, new MemoryBackend());
    const diskError = new Error("the disk is gone");
    let isGone = false;
    const store = newStore({
      ...backend,
      get: (link) => (isGone ? Promise.reject(diskError) : backend.get(link)),
    });
    await recordIn(store, [first], schemas);
    await store.scan(noteNames);
    await recordIn(store, [second]);
    isGone = true;
    await expect(store.scan(noteNames)).rejects.toBe(diskError);
    isGone = false;
    requestedLinks.length = 0;
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "b"]);
    expect(requestedLinks).not.toContain(first.link);
  });
});

describe("the rows of an index", () => {
  const counted = schema("Counted", { name: string(), n: integer() });
  const countedOf = ({ data: { name, n } }: { readonly data: Entry }) =>
    name === undefined || n === undefined ? [] : [{ name, n }];
  const countedNotes = indexOver(selectedRecords(objectsOf(note)), counted, countedOf);
  const [first, second, third] = [
    encodeObject(note, { name: "a", n: 3 }),
    encodeObject(note, { name: "c", n: 1 }),
    encodeObject(note, { name: "b", n: 2 }),
  ];
  const sortedNamesOf = async (rows: Rows<DataOf<typeof counted>>) =>
    (await rowDataOf(rows.orderedBy("name").range([]))).map(({ name }) => name);
  const sortedCountsOf = async (rows: Rows<DataOf<typeof counted>>) =>
    (await rowDataOf(rows.orderedBy("n").range([]))).map(({ n }) => n);

  it("are each given once when gone through", async () => {
    const store = newStore();
    await recordIn(store, [first, second, third], schemas);
    const names = (await rowDataOf(await store.scan(countedNotes))).map(({ name }) => name);
    expect(names.sort()).toEqual(["a", "b", "c"]);
  });

  it("are the same in each order", async () => {
    const store = newStore();
    await recordIn(store, [first, second, third], schemas);
    const rows = await store.scan(countedNotes);
    expect(await rowDataOf(rows.orderedBy("name").range([]))).toEqual([
      { name: "a", n: 3 },
      { name: "b", n: 2 },
      { name: "c", n: 1 },
    ]);
    expect(await rowDataOf(rows.orderedBy("n").range([]))).toEqual([
      { name: "c", n: 1 },
      { name: "b", n: 2 },
      { name: "a", n: 3 },
    ]);
    expect(await rowDataOf(rows.orderedBy("n").range([2]))).toEqual([{ name: "b", n: 2 }]);
  });

  it("are sorted once for an order asked again", async () => {
    const store = newStore();
    await recordIn(store, [first, second], schemas);
    const rows = await store.scan(countedNotes);
    expect(rows.orderedBy("name")).toBe(rows.orderedBy("name"));
    expect((await store.scan(countedNotes)).orderedBy("name")).toBe(rows.orderedBy("name"));
  });

  it("take into each order the rows given since those of an earlier scan were put in that order", async () => {
    const store = newStore();
    await recordIn(store, [first], schemas);
    expect(await sortedNamesOf(await store.scan(countedNotes))).toEqual(["a"]);
    await recordIn(store, [second]);
    expect(await sortedCountsOf(await store.scan(countedNotes))).toEqual([1, 3]);
    await recordIn(store, [third]);
    const rows = await store.scan(countedNotes);
    expect(await sortedNamesOf(rows)).toEqual(["a", "b", "c"]);
    expect(await sortedCountsOf(rows)).toEqual([1, 2, 3]);
  });

  it("keep to what their scan read, in an order that the rows of a later scan are put in first", async () => {
    const store = newStore();
    await recordIn(store, [first], schemas);
    const rows = await store.scan(countedNotes);
    await recordIn(store, [second]);
    expect(await sortedNamesOf(await store.scan(countedNotes))).toEqual(["a", "c"]);
    expect(await sortedNamesOf(rows)).toEqual(["a"]);
  });

  it("are sorted, on a staged batch, on top of the order its store keeps, which the batch adds nothing to", async () => {
    const countedBlobs = indexOver(selectedBlobs(objectsOf(note)), counted, countedOf);
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(backendNoting(requestedLinks, new MemoryBackend()));
    await store.write(batchOf([first], schemas));
    expect(await sortedCountsOf(await store.scan(countedBlobs))).toEqual([3]);
    requestedLinks.length = 0;
    const stagedStore = await store.stage(batchOf([second]));
    expect(await sortedCountsOf(await stagedStore.scan(countedBlobs))).toEqual([1, 3]);
    expect(requestedLinks).not.toContain(first.link);
    expect(await sortedCountsOf(await store.scan(countedBlobs))).toEqual([3]);
  });

  it("take an order first asked on a staged batch from the rows of its store, which keep it for the next batch", async () => {
    const countedBlobs = indexOver(selectedBlobs(objectsOf(note)), counted, countedOf);
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([first], schemas));
    const rowsWith = async (object: KeptObject) => (await store.stage(batchOf([object], tag.blobs))).scan(countedBlobs);

    const stagedRows = await rowsWith(encodeObject(tag, { name: "x" }));
    expect(stagedRows).not.toBe(await store.scan(countedBlobs));
    const sortedRows = stagedRows.orderedBy("n");
    expect((await store.scan(countedBlobs)).orderedBy("n")).toBe(sortedRows);
    expect((await rowsWith(encodeObject(tag, { name: "y" }))).orderedBy("n")).toBe(sortedRows);
  });

  it("are, in an order first asked on staged batches, those of each batch with its store and those of the store", async () => {
    const countedBlobs = indexOver(selectedBlobs(objectsOf(note)), counted, countedOf);
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([first], schemas));
    expect(await sortedCountsOf(await (await store.stage(batchOf([second]))).scan(countedBlobs))).toEqual([1, 3]);
    expect(await sortedCountsOf(await (await store.stage(batchOf([third]))).scan(countedBlobs))).toEqual([2, 3]);
    expect(await sortedCountsOf(await store.scan(countedBlobs))).toEqual([3]);
  });
});

describe("an index", () => {
  it("says the schema of its rows", () => {
    expect(noteNames.rowSchema).toBe(named);
  });
});

describe("an index over blobs", () => {
  const tagNames: NameIndex = indexOver(selectedBlobs(objectsOf(tag)), named, namedOf);
  const carrying = (...blobs: readonly Uint8Array[]) =>
    encodeObject(note, { attachments: blobs.map((blob) => new LinkValue(linkOf(blob))) });

  it("holds the rows of a blob of its schema that is not recorded, however deep in a recorded object's closure", async () => {
    const deep = encodeObject(tag, { names: ["deep"] });
    const near = encodeObject(tag, { names: ["near"], of: new LinkValue(deep.link) });
    const store = newStore();
    await recordIn(store, [carrying(near.bytes)], [deep.bytes, near.bytes, ...schemas]);
    expect(await namesOf(await store.scan(tagNames))).toEqual(["deep", "near"]);
    const recordedTagNames = indexOver(selectedRecords(objectsOf(tag)), named, namedOf);
    expect(await namesOf(await store.scan(recordedTagNames))).toEqual([]);
  });

  it("holds the rows of a root of its schema, and of no blob of another schema", async () => {
    const store = new Store(new MemoryBackend());
    await store.write(
      batchOf([encodeObject(tag, { names: ["tag"] }), encodeObject(note, { names: ["note"] })], schemas),
    );
    expect(await namesOf(await store.scan(tagNames))).toEqual(["tag"]);
  });

  it("holds no rows of a blob of the batch that the write did not keep", async () => {
    const store = new Store(new MemoryBackend());
    await store.write(
      batchOf([encodeObject(note, {})], [encodeObject(tag, { names: ["outside the closure"] }).bytes, ...schemas]),
    );
    expect(await namesOf(await store.scan(tagNames))).toEqual([]);
  });

  it("validates a blob of its schema once", async () => {
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([writtenByHand(tag, { names: ["validated once"] })], schemas));
    const validate = vi.spyOn(tag, "validate");
    expect(await namesOf(await store.scan(tagNames))).toEqual(["validated once"]);
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockRestore();
  });

  it("holds no rows of what its selection leaves out", async () => {
    const namedTags = new SelectionBySchema(tag, ({ data }) => data.name);
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([encodeObject(tag, { name: "a" }), encodeObject(tag, {})], schemas));
    expect(await namesOf(await store.scan(indexOver(selectedBlobs(namedTags), named, (name) => [{ name }])))).toEqual([
      "a",
    ]);
  });

  it.each([
    ["bytes that are not CBOR", new Uint8Array([0xff, 0xfe])],
    ["text", new TextEncoder().encode("an image")],
    ["CBOR that is not an object", Uint8Array.of(0x82, 1, 2)],
    ["a map under no tag of an object", Uint8Array.of(0xa1, 0x61, 0x61, 1)],
  ])("holds no rows of %s, which it does not fail on", async (_, blob) => {
    const other = encodeObject(tag, { names: ["other"] });
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([carrying(blob, other.bytes)], [blob, other.bytes, ...schemas]));
    const rows = await store.scan(tagNames);
    expect(await namesOf(rows)).toEqual(["other"]);
    expect(rows.failures).toEqual([]);
  });

  it("fails on a blob that names its schema and does not fit it, and still gives the rows of the other blobs", async () => {
    const strict = encodeSchema<Entry>({ title: "Named", fields: { name: string(), names: array(string()) } });
    const misfit = objectFormat.encode(new ObjectValue(strict.link, { names: ["misfit"] }));
    const fitting = encodeObject(strict, { name: "a", names: ["fitting"] });
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([carrying(misfit, fitting.bytes)], [misfit, fitting.bytes, strict.bytes, ...schemas]));
    const rows = await store.scan(indexOver(selectedBlobs(objectsOf(strict)), named, namedOf));
    expect(await namesOf(rows)).toEqual(["fitting"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });

  describe("whose selection or rows throw on a blob", () => {
    const [unreadable, readable] = [encodeObject(tag, { names: ["unreadable"] }), encodeObject(tag, { names: ["a"] })];
    const readableNamedOf = (object: { readonly data: Entry }) => {
      const rows = namedOf(object);
      if (rows[0]?.name === "unreadable") throw new Error("does not read");
      return rows;
    };

    async function rowsOf(index: NameIndex) {
      const store = new Store(new MemoryBackend());
      await store.write(batchOf([unreadable, readable], schemas));
      return store.scan(index);
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
      expect(rows.failures).toEqual([{ item: unreadable.link, error: new Error("does not read") }]);
    });

    it("keeps no row that its rows gave of the blob before they threw", async () => {
      const index = indexOver(selectedBlobs(objectsOf(tag)), named, function* (object) {
        yield* namedOf(object);
        readableNamedOf(object);
      });
      expect(await namesOf(await rowsOf(index))).toEqual(["a"]);
    });

    it("fails once, on a staged batch, on a blob that its store holds already", async () => {
      const index = indexOver(selectedBlobs(objectsOf(tag)), named, readableNamedOf);
      const carrierNamed = (name: string) => encodeObject(note, { names: [name], of: new LinkValue(unreadable.link) });
      const [first, second] = [carrierNamed("first"), carrierNamed("second")];
      const store = new Store(new MemoryBackend());
      await store.write(batchOf([first], [unreadable.bytes, ...schemas]));
      const stagedStore = await store.stage(batchOf([second, readable], [unreadable.bytes]));
      const stagedRows = await stagedStore.scan(index);
      expect(await namesOf(stagedRows)).toEqual(["a"]);
      expect(stagedRows.failures.map(({ item }) => item)).toEqual([unreadable.link]);
      await stagedStore.commit();
      expect((await store.scan(index)).failures).toEqual(stagedRows.failures);
    });
  });

  it("fails on a blob when the data of a row of it does not fit the schema of the index", async () => {
    const misfit = encodeObject(tag, { n: 1 });
    const store = new Store(new MemoryBackend());
    await store.write(batchOf([encodeObject(tag, { names: ["a"] }), misfit], schemas));
    const index = indexOver(selectedBlobs(objectsOf(tag)), named, (object) => [
      ...namedOf(object),
      ...(object.data.n === undefined ? [] : [{ name: object.data.n as unknown as string }]),
    ]);
    const rows = await store.scan(index);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([misfit.link]);
  });

  describe("on a store that fails", () => {
    const attachment = new TextEncoder().encode("an attachment");
    const other = encodeObject(tag, { names: ["other"] });
    const nested = encodeObject(tag, { names: ["nested"] });
    const reaching = encodeObject(tag, { names: ["reaching"], of: new LinkValue(nested.link) });
    const carrier = carrying(attachment, other.bytes, reaching.bytes);

    async function storeGiving(failingLink: Link<unknown>, give: () => Promise<Uint8Array | undefined>) {
      const failing = { isOn: true };
      const backend = new MemoryBackend();
      const store = new Store({
        get: (link) => (failing.isOn && link === failingLink ? give() : backend.get(link)),
        has: (link) => backend.has(link),
        put: (blobs) => backend.put(blobs),
        blobs: (start) => backend.blobs(start),
      });
      await store.write(batchOf([carrier], [attachment, other.bytes, nested.bytes, reaching.bytes, ...schemas]));
      return { store, failing };
    }

    it.each([
      ["an object of its schema", other.link],
      ["a blob of no schema", linkOf(attachment)],
      ["an object of another schema", carrier.link],
    ])("is not filled when the store throws for %s, and a later scan reads the blob", async (_, link) => {
      const diskError = new Error("the disk is gone");
      const { store, failing } = await storeGiving(link, () => Promise.reject(diskError));
      await expect(store.scan(tagNames)).rejects.toBe(diskError);
      failing.isOn = false;
      expect(await namesOf(await store.scan(tagNames))).toEqual(["nested", "other", "reaching"]);
    });

    const linkedFrom = (data: Entry) => data.of?.link;

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
      await expect(store.scan(index)).rejects.toBe(diskError);
      expect(readCount).toBe(2);
    });

    it("is not filled when the store does not hold a blob that it lists", async () => {
      const { store } = await storeGiving(other.link, async () => undefined);
      await expect(store.scan(tagNames)).rejects.toThrow(
        `a scan reads ${other.link}, and the store does not hold ${other.link} of its closure`,
      );
    });

    it("is not filled when the store holds another blob under a link", async () => {
      const { store } = await storeGiving(other.link, async () => nested.bytes);
      await expect(store.scan(tagNames)).rejects.toThrow(`another blob under ${other.link}`);
    });
  });

  describe("scanned again", () => {
    const [firstTag, secondTag] = [encodeObject(tag, { names: ["x"] }), encodeObject(tag, { names: ["y"] })];
    const [first, second] = [
      encodeObject(note, { names: ["a"], of: new LinkValue(firstTag.link) }),
      encodeObject(note, { names: ["b"], of: new LinkValue(secondTag.link) }),
    ];

    it("reads only the blobs put since the last scan", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(backendNoting(requestedLinks, new MemoryBackend()));
      await store.write(batchOf([first], [firstTag.bytes, ...schemas]));
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x"]);
      await store.write(batchOf([second], [secondTag.bytes]));
      requestedLinks.length = 0;
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x", "y"]);
      expect(requestedLinks.sort()).toEqual([second.link, secondTag.link].sort());
    });

    it("goes on from the last scan that went through, after one that fails", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const backend = backendNoting(requestedLinks, new MemoryBackend());
      const diskError = new Error("the disk is gone");
      let isGone = false;
      const store = new Store({
        ...backend,
        get: (link) => (isGone ? Promise.reject(diskError) : backend.get(link)),
      });
      await store.write(batchOf([first], [firstTag.bytes, ...schemas]));
      await store.scan(tagNames);
      await store.write(batchOf([second], [secondTag.bytes]));
      isGone = true;
      await expect(store.scan(tagNames)).rejects.toBe(diskError);
      isGone = false;
      requestedLinks.length = 0;
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("takes in the blobs that another store on the same backend writes", async () => {
      const backend = new MemoryBackend();
      const [store, other] = [new Store(backend), new Store(backend)];
      await store.write(batchOf([first], [firstTag.bytes, ...schemas]));
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x"]);
      await other.write(batchOf([second], [secondTag.bytes]));
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x", "y"]);
    });

    it("goes on with records and with blobs each from where it left off, in a union with an index of records", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
      const union = noteNames.union(tagNames);
      await recordIn(store, [first], [firstTag.bytes, ...schemas]);
      expect(await namesOf(await store.scan(union))).toEqual(["a", "x"]);
      await recordIn(store, [second], [secondTag.bytes]);
      requestedLinks.length = 0;
      expect(await namesOf(await store.scan(union))).toEqual(["a", "b", "x", "y"]);
      expect(requestedLinks).toContain(second.link);
      expect(requestedLinks).toContain(secondTag.link);
      expect(requestedLinks).not.toContain(first.link);
      expect(requestedLinks).not.toContain(firstTag.link);
    });

    it("reads, on a staged batch, the blobs the batch keeps on top of the rows its store keeps", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = new Store(backendNoting(requestedLinks, new MemoryBackend()));
      await store.write(batchOf([first], [firstTag.bytes, ...schemas]));
      await store.scan(tagNames);
      requestedLinks.length = 0;
      const stagedStore = await store.stage(
        batchOf([second], [secondTag.bytes, encodeObject(tag, { names: ["outside the closure"] }).bytes]),
      );
      expect(await namesOf(await stagedStore.scan(tagNames))).toEqual(["x", "y"]);
      expect(requestedLinks).not.toContain(firstTag.link);
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x"]);
      await stagedStore.commit();
      expect(await namesOf(await store.scan(tagNames))).toEqual(["x", "y"]);
    });
  });
});

describe("an index over every blob held", () => {
  const blobSizeSchema = schema("Sized", { blob: link(), size: integer() });
  const blobSizes = indexOver(heldBlobs, blobSizeSchema, ({ link, bytes }) => [
    { blob: new LinkValue(link), size: bytes.length },
  ]);
  const sizesIn = async (store: Pick<Store, "scan">) =>
    (await rowDataOf(await store.scan(blobSizes))).map(({ blob, size }) => [blob.link, size]).sort();
  // A blob that two schemas share is held once.
  const sizesOf = (...blobs: readonly Uint8Array[]) =>
    [...new Map(blobs.map((blob) => [linkOf(blob), blob.length]))].sort();
  const text = new TextEncoder().encode("an image");
  const first = encodeObject(tag, { names: ["a"] });
  const second = encodeObject(note, { attachments: [new LinkValue(linkOf(text))] });

  it("holds the rows of each blob by its link and bytes, an object of any schema and what is not an object", async () => {
    const store = newStore();
    await store.write(batchOf([first, second], [text, ...schemas]));
    expect(await sizesIn(store)).toEqual(sizesOf(first.bytes, second.bytes, text, ...schemas));
    expect((await store.scan(blobSizes)).failures).toEqual([]);
  });

  it("reads only the blobs put since the last scan", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store(backendNoting(requestedLinks, new MemoryBackend()));
    await store.write(batchOf([first], tag.blobs));
    expect(await sizesIn(store)).toEqual(sizesOf(first.bytes, ...tag.blobs));
    await store.write(batchOf([second], [text, ...note.blobs]));
    requestedLinks.length = 0;
    expect(await sizesIn(store)).toEqual(sizesOf(first.bytes, second.bytes, text, ...schemas));
    expect(requestedLinks).not.toContain(first.link);
    expect(requestedLinks).toContain(linkOf(text));
  });

  it("holds, on a staged batch, the rows of the blobs the batch keeps on top of those of its store", async () => {
    const store = newStore();
    await store.write(batchOf([first], tag.blobs));
    const stagedStore = await store.stage(batchOf([second], [text, ...note.blobs]));
    expect(await sizesIn(stagedStore)).toEqual(sizesOf(first.bytes, second.bytes, text, ...schemas));
    expect(await sizesIn(store)).toEqual(sizesOf(first.bytes, ...tag.blobs));
  });
});

describe("the rows of a scan", () => {
  const tagNames: NameIndex = indexOver(selectedBlobs(objectsOf(tag)), named, namedOf);
  const [firstTag, secondTag] = [encodeObject(tag, { names: ["x"] }), encodeObject(tag, { names: ["y"] })];
  const [first, second] = [
    encodeObject(note, { names: ["a"], of: new LinkValue(firstTag.link) }),
    encodeObject(note, { names: ["b"], of: new LinkValue(secondTag.link) }),
  ];

  async function blobCountOf(store: Store): Promise<number> {
    let count = 0;
    for await (const _ of store.blobs()) count++;
    return count;
  }

  it("say how many blobs the store held when they were read", async () => {
    const store = newStore();
    await recordIn(store, [first], [firstTag.bytes, ...schemas]);
    const heldCount = await blobCountOf(store);
    expect((await store.scan(noteNames)).blobCount).toBe(heldCount);
    const attachment = new TextEncoder().encode("an attachment");
    await store.write({ roots: [linkOf(attachment)], blobs: [attachment] });
    const rows = await store.scan(noteNames);
    expect(await namesOf(rows)).toEqual(["a"]);
    expect(rows.blobCount).toBe(heldCount + 1);
    expect((await store.scan(noteNames)).blobCount).toBe(heldCount + 1);
  });

  it("are those of the blobs they count, though more are written while an index of records and of blobs is read", async () => {
    const backend = new MemoryBackend();
    const writer = newStore(backend);
    let writeAfterListing: (() => Promise<void>) | undefined;
    const store = newStore({
      get: (link) => backend.get(link),
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      async *blobs(start) {
        yield* backend.blobs(start);
        const write = writeAfterListing;
        writeAfterListing = undefined;
        await write?.();
      },
    });
    const union = noteNames.union(tagNames);
    await recordIn(writer, [first], [firstTag.bytes, ...schemas]);
    const heldCount = await blobCountOf(writer);
    writeAfterListing = () => recordIn(writer, [second], [secondTag.bytes]);
    const rows = await store.scan(union);
    expect(await namesOf(rows)).toEqual(["a", "x"]);
    expect(rows.blobCount).toBe(heldCount);
    const laterRows = await store.scan(union);
    expect(await namesOf(laterRows)).toEqual(["a", "b", "x", "y"]);
    expect(laterRows.blobCount).toBe(await blobCountOf(writer));
  });

  it("count, on a staged batch, the blobs the store would hold once the batch is written", async () => {
    const store = newStore();
    await store.write(batchOf([firstTag], schemas));
    const heldCount = await blobCountOf(store);
    const stagedStore = await store.stage(batchOf([firstTag, secondTag]));
    const stagedRows = await stagedStore.scan(tagNames);
    expect(await namesOf(stagedRows)).toEqual(["x", "y"]);
    expect(stagedRows.blobCount).toBe(heldCount + 1);
    await stagedStore.commit();
    expect(await blobCountOf(store)).toBe(heldCount + 1);
  });
});

describe("an index over another index", () => {
  const upperNames: NameIndex = indexOver(noteNames, named, ({ data }) => [{ name: data.name.toUpperCase() }]);
  const [first, second] = [encodeObject(note, { names: ["a"] }), encodeObject(note, { names: ["b"] })];

  it("holds the rows that its rows give of each row of the other index", async () => {
    const store = newStore();
    await recordIn(store, [encodeObject(note, { names: ["b", "a"] })], schemas);
    expect(await namesOf(await store.scan(upperNames))).toEqual(["A", "B"]);
    expect(await namesOf(await store.scan(noteNames))).toEqual(["a", "b"]);
  });

  it("holds no rows of an object of the schema of those rows that the store holds", async () => {
    const [listed, unlisted] = [encodeObject(named, { name: "listed" }), encodeObject(named, { name: "unlisted" })];
    const store = newStore();
    await recordIn(
      store,
      [first, listed, encodeObject(note, { of: new LinkValue(unlisted.link) })],
      [unlisted.bytes, named.bytes, ...schemas],
    );
    expect(await namesOf(await store.scan(upperNames))).toEqual(["A"]);
  });

  it("leaves its rows and those it reads out of the store, and out of an index over the blobs of their schema", async () => {
    const store = newStore();
    await recordIn(store, [first], [named.bytes, ...schemas]);
    const rows = [await store.scan(noteNames), await store.scan(upperNames)];
    for (const each of rows) for await (const { link } of each) expect(await store.get(link)).toBeUndefined();
    const namedBlobs = indexOver(selectedBlobs(objectsOf(named)), named, ({ data }) => [data]);
    expect(await namesOf(await store.scan(namedBlobs))).toEqual([]);
  });

  it("reads through the indexes it is over: their rows by link, and what those link to from the store", async () => {
    const traced = schema("Traced", { name: string(), from: link() });
    const tracedNotes = indexOver(selectedRecords(plainSelectionOf(objectsOf(note))), traced, ({ link, data }) =>
      (data.names ?? []).map((name) => ({ name, from: new LinkValue(link) })),
    );
    const tracedRows = indexOver(tracedNotes, traced, ({ link, data }) => [
      { name: data.name.toUpperCase(), from: new LinkValue(link) },
    ]);
    const sources = indexOver(tracedRows, named, async function* ({ data }, reader) {
      const row = await readObject(reader, data.from.link, traced);
      const record = await readObject(reader, row.data.from.link, note);
      yield { name: `${data.name} from ${row.data.name} of ${record.data.n}` };
    });
    const store = newStore();
    await recordIn(store, [encodeObject(note, { names: ["a", "b"], n: 1 })], schemas);
    expect(await namesOf(await store.scan(sources))).toEqual(["A from a of 1", "B from b of 1"]);
  });

  it("reads the closure of a row through the indexes it is over, with the schemas of their rows, which the store does not hold", async () => {
    const traced = schema("Traced", { name: string(), from: link() });
    const retraced = schema("Retraced", { name: string(), from: link() });
    const tracedNotes = indexOver(selectedRecords(objectsOf(note)), traced, ({ link, data }) =>
      (data.names ?? []).map((name) => ({ name, from: new LinkValue(link) })),
    );
    const retracedRows = indexOver(tracedNotes, retraced, ({ link, data }) => [
      { name: data.name.toUpperCase(), from: new LinkValue(link) },
    ]);
    const closure = new Set<Link<unknown>>();
    const closures = indexOver(retracedRows, named, async function* ({ link, data }, reader) {
      const pending: Link<unknown>[] = [link];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (closure.has(next)) continue;
        closure.add(next);
        const bytes = await reader.get(next);
        if (bytes !== undefined) pending.push(...objectFormat.links(objectFormat.decode(bytes)));
      }
      yield { name: data.name };
    });
    const tracedRow = encodeObject(traced, { name: "a", from: new LinkValue(first.link) });
    const retracedRow = encodeObject(retraced, { name: "A", from: new LinkValue(tracedRow.link) });
    const store = newStore();
    await recordIn(store, [first], schemas);
    expect(await namesOf(await store.scan(closures))).toEqual(["A"]);
    expect(closure).toEqual(
      new Set([retracedRow.link, retraced.link, tracedRow.link, traced.link, first.link, note.link, rootSchema.link]),
    );
    for (const { link } of [retraced, traced]) expect(await store.get(link)).toBeUndefined();
  });

  it("hands on a row of the other index as that index wrote it, validated once", async () => {
    const namedCounting = schema("Counted Name", { name: string() });
    const validate = vi.spyOn(namedCounting, "validate");
    const names = indexOver(selectedRecords(objectsOf(note)), namedCounting, namedOf);
    const upper: NameIndex = indexOver(names, named, ({ data }) => [{ name: `${data.name}`.toUpperCase() }]);
    const store = newStore();
    await recordIn(store, [first], schemas);
    expect(await namesOf(await store.scan(upper))).toEqual(["A"]);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("holds its rows with those of an index of records, in a union", async () => {
    const store = newStore();
    await recordIn(store, [first, encodeObject(tag, { names: ["t"] })], schemas);
    const union = upperNames.union(indexOver(selectedRecords(objectsOf(tag)), named, namedOf));
    expect(await namesOf(await store.scan(union))).toEqual(["A", "t"]);
  });

  describe("scanned again", () => {
    /** An index over `names` that notes in `readNames` each row it reads. */
    const upperNamesNoting = (readNames: string[], names: NameIndex = noteNames): NameIndex =>
      indexOver(names, named, ({ data }) => {
        readNames.push(data.name);
        return [{ name: data.name.toUpperCase() }];
      });

    it("reads only the rows that the other index gave since the last scan", async () => {
      const readNames: string[] = [];
      const index = upperNamesNoting(readNames);
      const store = newStore();
      await recordIn(store, [first], schemas);
      expect(await namesOf(await store.scan(index))).toEqual(["A"]);
      await recordIn(store, [second]);
      expect(await namesOf(await store.scan(index))).toEqual(["A", "B"]);
      expect(readNames).toEqual(["a", "b"]);
    });

    it("reads each recorded object once for the other index and each index over it", async () => {
      const requestedLinks: Link<unknown>[] = [];
      const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
      await recordIn(store, [first], schemas);
      await listRecordsOf(store);
      requestedLinks.length = 0;
      await store.scan(upperNames);
      await store.scan(noteNames);
      await store.scan(upperNamesNoting([]));
      expect(requestedLinks.filter((link) => link === first.link)).toHaveLength(1);
    });

    it("reads, on a staged batch, the rows that the other index gives of the batch on top of those its store keeps", async () => {
      const readNames: string[] = [];
      const index = upperNamesNoting(readNames, indexOver(selectedBlobs(objectsOf(note)), named, namedOf));
      const store = new Store(new MemoryBackend());
      await store.write(batchOf([first], schemas));
      await store.scan(index);
      const stagedStore = await store.stage(batchOf([second]));
      expect(await namesOf(await stagedStore.scan(index))).toEqual(["A", "B"]);
      expect(readNames).toEqual(["a", "b"]);
      expect(await namesOf(await store.scan(index))).toEqual(["A"]);
      await stagedStore.commit();
      expect(await namesOf(await store.scan(index))).toEqual(["A", "B"]);
    });
  });
});

describe("an index over the blobs that the rows of another index link to", () => {
  const cardSchema = schema("Card Link", { card: link(), by: string() });
  const noteCards = indexOver(selectedRecords(objectsOf(note)), cardSchema, ({ data }) =>
    data.card === undefined ? [] : [{ card: data.card, by: data.names?.[0] ?? "" }],
  );
  const blobSizeSchema = schema("Sized", { blob: link(), size: integer() });
  const sizesOver = (index: typeof noteCards) =>
    indexOver(index.linksAt("card"), blobSizeSchema, ({ link, bytes }) => [
      { blob: new LinkValue(link), size: bytes.length },
    ]);
  const cardSizes = sizesOver(noteCards);
  const sizesIn = async (store: Pick<Store, "scan">, index = cardSizes) =>
    (await rowDataOf(await store.scan(index))).map(({ blob, size }) => [blob.link, size]).sort();
  const sizesOf = (...blobs: readonly Uint8Array[]) => blobs.map((blob) => [linkOf(blob), blob.length]).sort();
  const image = new TextEncoder().encode("an image");
  const card = encodeObject(tag, { name: "Alice" });
  const noteOf = (target: Link<unknown>, by: string) =>
    encodeObject(note, { card: new LinkValue(target), names: [by] });

  it("holds the rows of each blob linked to, an object of any schema and what is not an object", async () => {
    const store = newStore();
    await recordIn(store, [noteOf(card.link, "a"), noteOf(linkOf(image), "b")], [card.bytes, image, ...schemas]);
    expect(await sizesIn(store)).toEqual(sizesOf(card.bytes, image));
    expect((await store.scan(cardSizes)).failures).toEqual([]);
  });

  it("holds no rows of a blob that the store holds and no row links to", async () => {
    const store = newStore();
    const unrecorded = noteOf(linkOf(image), "sent");
    await store.write(batchOf([unrecorded, card], [image, ...schemas]));
    await recordIn(store, [encodeObject(note, { about: new LinkValue(card.link) })]);
    expect(await sizesIn(store)).toEqual([]);
  });

  it("reads a blob once, however many rows link to it", async () => {
    const readLinks: Link<unknown>[] = [];
    const index = indexOver(noteCards.linksAt("card"), blobSizeSchema, ({ link, bytes }) => {
      readLinks.push(link);
      return [{ blob: new LinkValue(link), size: bytes.length }];
    });
    const store = newStore();
    await recordIn(store, [noteOf(card.link, "a"), noteOf(card.link, "b")], [card.bytes, ...schemas]);
    expect(await sizesIn(store, index)).toEqual(sizesOf(card.bytes));
    expect(readLinks).toEqual([card.link]);
  });

  it("reads each blob once for the indexes of a union that read the same links of the same index", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    await recordIn(store, [noteOf(card.link, "a")], [card.bytes, ...schemas]);
    await listRecordsOf(store);
    requestedLinks.length = 0;
    const lengths = indexOver(noteCards.linksAt("card"), blobSizeSchema, ({ link }) => [
      { blob: new LinkValue(link), size: link.length },
    ]);
    expect(await sizesIn(store, cardSizes.union(lengths))).toHaveLength(2);
    expect(requestedLinks.filter((link) => link === card.link)).toHaveLength(1);
  });

  it("reads on a later scan only the blobs that rows have linked to since", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = newStore(backendNoting(requestedLinks, new MemoryBackend()));
    await recordIn(store, [noteOf(card.link, "a")], [card.bytes, ...schemas]);
    expect(await sizesIn(store)).toEqual(sizesOf(card.bytes));
    await recordIn(store, [noteOf(linkOf(image), "b"), noteOf(card.link, "c")], [image]);
    requestedLinks.length = 0;
    expect(await sizesIn(store)).toEqual(sizesOf(card.bytes, image));
    expect(requestedLinks).not.toContain(card.link);
    expect(requestedLinks).toContain(linkOf(image));
  });

  it("gives the rows of its last scan again where nothing was put since", async () => {
    const store = newStore();
    await recordIn(store, [noteOf(card.link, "a")], [card.bytes, ...schemas]);
    const rows = await store.scan(cardSizes);
    expect(await store.scan(cardSizes)).toBe(rows);
  });

  it("holds, on a staged batch, the rows of what the rows of the batch link to on top of those its store keeps", async () => {
    const blobCards = indexOver(selectedBlobs(objectsOf(note)), cardSchema, ({ data }) =>
      data.card === undefined ? [] : [{ card: data.card, by: "" }],
    );
    const index = sizesOver(blobCards);
    const store = newStore();
    await store.write(batchOf([noteOf(card.link, "a")], [card.bytes, ...schemas]));
    expect(await sizesIn(store, index)).toEqual(sizesOf(card.bytes));
    const stagedStore = await store.stage(batchOf([noteOf(linkOf(image), "b")], [image]));
    expect(await sizesIn(stagedStore, index)).toEqual(sizesOf(card.bytes, image));
    expect(await sizesIn(store, index)).toEqual(sizesOf(card.bytes));
  });

  it("lists the blob that its rows throw on, and not the row that links to it", async () => {
    const readError = new Error("does not read");
    const index = indexOver(noteCards.linksAt("card"), blobSizeSchema, ({ link, bytes }) => {
      if (link === card.link) throw readError;
      return [{ blob: new LinkValue(link), size: bytes.length }];
    });
    const store = newStore();
    await recordIn(store, [noteOf(card.link, "a"), noteOf(linkOf(image), "b")], [card.bytes, image, ...schemas]);
    const rows = await store.scan(index);
    expect(await sizesIn(store, index)).toEqual(sizesOf(image));
    expect(rows.failures).toEqual([{ item: card.link, error: readError }]);
  });

  it("has among its failures what the index that gives the rows failed on", async () => {
    const readError = new Error("does not read");
    const readableCards = indexOver(selectedRecords(objectsOf(note)), cardSchema, ({ data }) => {
      if (data.card === undefined) throw readError;
      return [{ card: data.card, by: "" }];
    });
    const unreadable = encodeObject(note, { names: ["unreadable"] });
    const store = newStore();
    await recordIn(store, [unreadable, noteOf(card.link, "a")], [card.bytes, ...schemas]);
    const rows = await store.scan(sizesOver(readableCards));
    expect(rows.failures).toEqual([{ item: unreadable.link, error: readError }]);
  });

  it("reads a row of an index that the rows link to, which the store does not hold", async () => {
    const tracedSchema = schema("Traced Name", { name: string(), row: link() });
    const tracedNames = indexOver(noteNames, tracedSchema, ({ link, data }) => [
      { name: data.name, row: new LinkValue(link) },
    ]);
    const index = indexOver(tracedNames.linksAt("row"), blobSizeSchema, ({ link, bytes }) => [
      { blob: new LinkValue(link), size: bytes.length },
    ]);
    const store = newStore();
    await recordIn(store, [encodeObject(note, { names: ["a"] })], schemas);
    const row = encodeObject(named, { name: "a" });
    expect(await sizesIn(store, index)).toEqual(sizesOf(row.bytes));
    expect(await store.get(row.link)).toBeUndefined();
  });

  describe("where a row links to a blob that the store does not hold", () => {
    const absentCardSizes = sizesOver(
      indexOver(selectedRecords(objectsOf(note)), cardSchema, () => [{ card: new LinkValue(linkOf(image)), by: "" }]),
    );
    const refusal = `a scan reads ${linkOf(image)}, and the store does not hold ${linkOf(image)} of its closure`;

    it("is not filled", async () => {
      const store = newStore();
      await recordIn(store, [encodeObject(note, { names: ["a"] })], schemas);
      await expect(store.scan(absentCardSizes)).rejects.toThrow(refusal);
    });

    it("is not filled over a staged batch that holds the blob, and is once the batch is committed", async () => {
      const store = newStore();
      await recordIn(store, [encodeObject(note, { names: ["a"] })], schemas);
      const stagedStore = await store.stage({ roots: [linkOf(image)], blobs: [image] });
      await expect(stagedStore.scan(absentCardSizes)).rejects.toThrow(refusal);
      await stagedStore.commit();
      expect(await sizesIn(store, absentCardSizes)).toEqual(sizesOf(image));
    });
  });

  test("the compiler rejects a field name written out under which a row may hold no link", () => {
    const optionalCards = indexOver(selectedRecords(objectsOf(note)), note, ({ data }) => [data]);
    // @ts-expect-error: a row holds text under `by`
    noteCards.linksAt("by");
    // @ts-expect-error: a row may leave `card` out
    optionalCards.linksAt("card");
  });

  test("a field name passed as a string is not checked, and a scan throws on a row that holds no link under it", async () => {
    const cardLinks = indexOver(selectedRecords(objectsOf(note)), schema("Card Only", { card: link() }), () => [
      { card: new LinkValue(linkOf(image)) },
    ]);
    const misspelled: string = "crad";
    const store = newStore();
    await recordIn(store, [encodeObject(note, { names: ["a"] })], schemas);
    await expect(store.scan(indexOver(cardLinks.linksAt(misspelled), blobSizeSchema, () => []))).rejects.toThrow(
      TypeError,
    );
  });
});
