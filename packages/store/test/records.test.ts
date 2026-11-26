import { type EncodedObject, encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { integer, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  indexOver,
  MemoryBackend,
  RefusedBatch,
  recordSchema,
  Store,
  selectedBlobs,
  selectedRecords,
  sendableBlobs,
  view,
  writtenObjectSchema,
  writtenObjectsOf,
  writtenObjectsOver,
} from "../src/index.ts";

const cardSchema = schema("Card", { name: string() });
const takenSchema = schema("Taken", { card: link(), at: integer() });
const shownSchema = schema("Shown", { card: link() });
const card = (name: string) => encodeObject(cardSchema, { name });
const taken = (of: { readonly link: Link<unknown> }, at: number) =>
  encodeObject(takenSchema, { card: new LinkValue(of.link), at });
const utf8 = (text: string) => new TextEncoder().encode(text);
const recordOf = (statement: { readonly link: Link<unknown> }) =>
  encodeObject(recordSchema, { object: new LinkValue(statement.link as Link<EncodedObject>) });
const batchOf = (statements: readonly EncodedObject[], blobs: readonly Uint8Array[] = []) => ({
  statements: statements.map(({ link }) => link),
  blobs: [...statements.map(({ bytes }) => bytes), ...blobs],
});

function sides() {
  const backend = new MemoryBackend();
  return { backend, store: new Store(backend) };
}

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

const namedSchema = schema("Named", { name: string(), at: integer() });
const takenNames = () =>
  indexOver(selectedRecords(objectsOf(takenSchema)), namedSchema, async function* ({ data }, reader) {
    yield { name: (await readObject(reader, data.card.link, cardSchema)).data.name, at: data.at };
  });

async function namesIn(store: Store, index = takenNames()): Promise<string[]> {
  const names: string[] = [];
  for await (const { data } of (await store.scan(index)).orderedBy("at").range([])) names.push(data.name);
  return names;
}

describe("records", () => {
  it("are listed by their statements in the order they were written, which the store gives as any blob", async () => {
    const { store } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const [first, second] = [taken(bob, 1), taken(alice, 2)];
    await store.record(batchOf([first], [...takenSchema.blobs]));
    await store.record(batchOf([second]));
    expect(await store.get(first.link)).toEqual(first.bytes);
    expect(await listOf(store.records())).toEqual([first.link, second.link]);
    expect(await listOf(store.blobs())).toContain(first.link);
  });

  it("are listed once each, however often a statement is recorded", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const statement = taken(alice, 1);
    await store.record(batchOf([statement, statement], [...takenSchema.blobs]));
    await store.record(batchOf([statement]));
    expect(await listOf(store.records())).toEqual([statement.link]);
  });

  it("are listed by another store on the same backend", async () => {
    const { backend, store } = sides();
    const alice = card("Alice");
    const statement = taken(alice, 1);
    await store.record(batchOf([statement], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs]));
    expect(await listOf(new Store(backend).records())).toEqual([statement.link]);
  });

  it("are found by reading each blob the store holds once, however often they are listed", async () => {
    const backend = new MemoryBackend();
    const requestedLinks: Link<unknown>[] = [];
    const store = new Store({
      get: (link) => {
        requestedLinks.push(link);
        return backend.get(link);
      },
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    });
    const alice = card("Alice");
    await store.record(batchOf([taken(alice, 1)], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs]));
    const blobs = await listOf(store.blobs());
    await listOf(store.records());
    await listOf(store.records());
    expect(requestedLinks.sort()).toEqual(blobs.sort());
    const second = taken(alice, 2);
    await store.record(batchOf([second]));
    requestedLinks.length = 0;
    await listOf(store.records());
    expect(requestedLinks.filter((link) => blobs.includes(link))).toEqual([]);
    expect(requestedLinks).toContain(second.link);
  });

  it("are listed with how many blobs the store held, as they were then though more are recorded meanwhile", async () => {
    const { backend, store: writer } = sides();
    let recordAfterListing: (() => Promise<void>) | undefined;
    const store = new Store({
      get: (link) => backend.get(link),
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      async *blobs(start) {
        yield* backend.blobs(start);
        const record = recordAfterListing;
        recordAfterListing = undefined;
        await record?.();
      },
    });
    const [first, second] = [card("Alice"), card("Bob")];
    await writer.record(batchOf([first], [...cardSchema.blobs]));
    const heldCount = (await listOf(writer.blobs())).length;
    recordAfterListing = () => writer.record(batchOf([second]));
    expect(await store.recordedStatements()).toEqual({ statements: [first.link], blobCount: heldCount });
    expect(await store.recordedStatements()).toEqual({
      statements: [first.link, second.link],
      blobCount: (await listOf(writer.blobs())).length,
    });
  });

  it("list a statement that came to the store before it was recorded", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const statement = taken(alice, 1);
    await store.write({
      roots: [alice.link, statement.link],
      blobs: [alice.bytes, statement.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    expect(await listOf(store.records())).toEqual([]);
    await store.record(batchOf([statement]));
    expect(await listOf(store.records())).toEqual([statement.link]);
  });

  it("are each a Record that the store writes after the closure of its statement", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const statement = taken(alice, 1);
    await store.record(batchOf([statement], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs]));
    const record = recordOf(statement);
    expect(await store.get(record.link)).toEqual(record.bytes);
    const blobs = await listOf(store.blobs());
    const closure = [...(await store.closure(statement.link)).keys()];
    expect(closure.map((link) => blobs.indexOf(link)).every((at) => at < blobs.indexOf(record.link))).toBe(true);
  });

  it("keep what the batch gives of a statement's closure, and drop the rest", async () => {
    const { backend, store } = sides();
    const alice = card("Alice");
    const stray = utf8("not in the closure");
    await store.record(batchOf([taken(alice, 1)], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs, stray]));
    expect(await backend.has(alice.link)).toBe(true);
    expect(await backend.has(takenSchema.link)).toBe(true);
    expect(await backend.has(linkOf(stray))).toBe(false);
  });

  it("refuse a batch with a blob in a statement's closure that neither the batch nor the store holds", async () => {
    const { store } = sides();
    const absent = card("absent");
    const statement = taken(absent, 1);
    await expect(store.record(batchOf([statement], [...takenSchema.blobs]))).rejects.toThrow(
      `${statement.link} links to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await listOf(store.records())).toEqual([]);
  });

  it("list the Record schema as any statement, when the batch gives its blob", async () => {
    const { store } = sides();
    await store.record({ statements: [recordSchema.link], blobs: recordSchema.blobs });
    expect(await listOf(store.records())).toEqual([recordSchema.link]);
  });

  it("refuse a batch that gives another statement and not the blob of the Record schema it records", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const refusal = store.record({
      statements: [alice.link, recordSchema.link],
      blobs: [alice.bytes, ...cardSchema.blobs],
    });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${recordSchema.link} is recorded but is not among the blobs of the batch`);
    expect(await listOf(store.blobs())).toEqual([]);
  });

  it("refuse a statement that is not an object", async () => {
    const { store } = sides();
    const image = utf8("an image");
    const refusal = store.record({ statements: [linkOf(image)], blobs: [image] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${linkOf(image)} is recorded but is not an object`);
  });

  it("refuse a statement whose blob the batch does not give, though the store holds it", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const statement = taken(alice, 1);
    await store.write({
      roots: [alice.link, statement.link],
      blobs: [alice.bytes, statement.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    const refusal = store.record({ statements: [statement.link], blobs: [] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${statement.link} is recorded but is not among the blobs of the batch`);
    expect(await listOf(store.records())).toEqual([]);
  });
});

describe("a store given a batch with a Record among its blobs", () => {
  const alice = card("Alice");
  const statement = taken(alice, 1);
  const record = recordOf(statement);
  const closureBlobs = [statement.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs];
  const blobs = [record.bytes, ...recordSchema.blobs, ...closureBlobs];
  const refusal = `${record.link} is a Record, which a batch does not give`;

  it("refuses to write it, and keeps nothing of it", async () => {
    const { store } = sides();
    const written = store.write({ roots: [record.link], blobs });
    await expect(written).rejects.toThrow(RefusedBatch);
    await expect(written).rejects.toThrow(refusal);
    expect(await listOf(store.blobs())).toEqual([]);
  });

  it("refuses to write it though no root reaches the Record", async () => {
    const { store } = sides();
    await expect(store.write({ roots: [statement.link], blobs })).rejects.toThrow(refusal);
  });

  it("refuses to stage it", async () => {
    const { store } = sides();
    await expect(store.stage({ roots: [record.link], blobs })).rejects.toThrow(refusal);
  });

  it("refuses to record it, though it would write the same Record", async () => {
    const { store } = sides();
    await expect(store.record({ statements: [statement.link], blobs })).rejects.toThrow(refusal);
    expect(await listOf(store.records())).toEqual([]);
  });
});

describe("a store given a batch that links to a Record", () => {
  const alice = card("Alice");
  const statement = taken(alice, 1);
  const record = recordOf(statement);
  const shown = encodeObject(shownSchema, { card: new LinkValue(record.link) });
  const statementBlobs = [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs];

  it("writes it once it holds the Record", async () => {
    const { store } = sides();
    await store.record(batchOf([statement], statementBlobs));
    await store.write({ roots: [shown.link], blobs: [shown.bytes, ...shownSchema.blobs] });
    expect(await store.get(shown.link)).toEqual(shown.bytes);
    expect(await listOf(store.records())).toEqual([statement.link]);
  });

  it("stages it once it holds the Record", async () => {
    const { store } = sides();
    await store.record(batchOf([statement], statementBlobs));
    const stagedStore = await store.stage({ roots: [shown.link], blobs: [shown.bytes, ...shownSchema.blobs] });
    expect(await stagedStore.get(shown.link)).toEqual(shown.bytes);
  });

  it("refuses to write it before it holds the Record, for a blob it does not hold", async () => {
    const { store } = sides();
    await expect(store.write({ roots: [shown.link], blobs: [shown.bytes, ...shownSchema.blobs] })).rejects.toThrow(
      `${shown.link} links to ${record.link}, which neither the batch nor the store holds`,
    );
  });

  it("records the statement together with one that links to its Record, which it writes first", async () => {
    const { store } = sides();
    await store.record(batchOf([statement, shown], [...statementBlobs, ...shownSchema.blobs]));
    expect(await listOf(store.records())).toEqual([statement.link, shown.link]);
    const blobs = await listOf(store.blobs());
    expect(blobs.indexOf(record.link)).toBeLessThan(blobs.indexOf(shown.link));
  });

  it("records a statement that links to a Record it holds", async () => {
    const { store } = sides();
    await store.record(batchOf([statement], statementBlobs));
    await store.record(batchOf([shown], [...shownSchema.blobs]));
    expect(await listOf(store.records())).toEqual([statement.link, shown.link]);
  });
});

describe("a store that records a statement", () => {
  it("gives the closure of the statement, and of what links to it, as of any blob", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const statement = taken(alice, 1);
    await store.record(batchOf([statement], [...takenSchema.blobs]));
    const shown = encodeObject(shownSchema, { card: new LinkValue(statement.link) });
    await store.write({ roots: [shown.link], blobs: [shown.bytes, ...shownSchema.blobs] });
    expect([...(await store.closure(statement.link)).keys()]).toEqual(
      expect.arrayContaining([statement.link, alice.link]),
    );
    expect([...(await store.closure(shown.link)).keys()]).toEqual(expect.arrayContaining([shown.link, statement.link]));
  });

  it("gives its Record among the blobs of the closure of the Record, which are not sent", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const statement = taken(alice, 1);
    await store.record(batchOf([statement], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs]));
    const record = recordOf(statement);
    const closure = await store.closure(record.link);
    expect(() => [...sendableBlobs(closure.values())]).toThrow(`${record.link} is a Record, which is not sent`);
    expect([...sendableBlobs((await store.closure(statement.link)).values())]).toHaveLength(closure.size - 2);
  });
});

describe("an index over records", () => {
  it("reads the statements that its selection takes, and through them what the store holds", async () => {
    const { store } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await store.record(
      batchOf(
        [taken(bob, 1), taken(alice, 2), encodeObject(shownSchema, { card: new LinkValue(alice.link) })],
        [...takenSchema.blobs, ...shownSchema.blobs],
      ),
    );
    expect(await namesIn(store)).toEqual(["Bob", "Alice"]);
  });

  it("reads no statement that only came to the store", async () => {
    const { store } = sides();
    const [alice, mallory] = [card("Alice"), card("Mallory")];
    const sentStatement = taken(mallory, 0);
    await store.write({
      roots: [alice.link, sentStatement.link],
      blobs: [alice.bytes, sentStatement.bytes, mallory.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    expect(await namesIn(store)).toEqual([]);
    await store.record(batchOf([taken(alice, 1)]));
    expect(await namesIn(store)).toEqual(["Alice"]);
  });

  it("reads on a later scan only the statements recorded since", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const readTimes: number[] = [];
    const index = indexOver(selectedRecords(objectsOf(takenSchema)), namedSchema, ({ data }) => {
      readTimes.push(data.at);
      return [{ name: "", at: data.at }];
    });
    await store.record(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await store.scan(index);
    await store.record(batchOf([taken(alice, 2)]));
    expect((await listOf((await store.scan(index)).orderedBy("at").range([]))).map(({ data }) => data.at)).toEqual([
      1, 2,
    ]);
    expect(readTimes).toEqual([1, 2]);
  });

  it("lists the Record of a statement that its rows throw on", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    await store.record(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    const refusal = new Error("not read");
    const index = indexOver(selectedRecords(objectsOf(takenSchema)), namedSchema, () => {
      throw refusal;
    });
    expect((await store.scan(index)).failures).toEqual([{ item: recordOf(taken(alice, 1)).link, error: refusal }]);
  });

  it("gives a view its rows, with the store to read what they name", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    await store.record(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    const latest = await view(store, {
      index: indexOver(selectedRecords(objectsOf(takenSchema)), takenSchema, ({ data }) => [data]),
      read: async (rows, reader) => {
        const [row] = await listOf(rows.orderedBy("at").range([]));
        return row && (await readObject(reader, row.data.card.link, cardSchema)).data.name;
      },
    });
    expect(latest).toBe("Alice");
  });
});

describe("an index over written objects", () => {
  const writtenNames = () =>
    indexOver(selectedRecords(writtenObjectsOver(objectsOf(cardSchema))), namedSchema, ({ data }) => [
      { name: data.name, at: 0 },
    ]);
  const namesByName = async (store: Store, index: ReturnType<typeof writtenNames>) =>
    (await listOf((await store.scan(index)).orderedBy("name").range([]))).map(({ data }) => data.name);

  it("reads the objects that the Written Objects among the records link to", async () => {
    const { store } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await store.record(batchOf([taken(bob, 1)], [...takenSchema.blobs]));
    await store.record(writtenObjectsOf([alice.link], 1));
    expect(await namesByName(store, writtenNames())).toEqual(["Alice"]);
  });

  it("reads nothing for a Written Object that links to a blob that is not an object, and reads the others", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const image = utf8("not an object");
    await store.write({ roots: [alice.link, linkOf(image)], blobs: [alice.bytes, ...cardSchema.blobs, image] });
    await store.record(writtenObjectsOf([alice.link, linkOf(image)], 1));
    expect(await namesByName(store, writtenNames())).toEqual(["Alice"]);
  });

  it("reads no object whose Written Object only came to the store", async () => {
    const { store } = sides();
    const mallory = card("Mallory");
    const { statements, blobs } = writtenObjectsOf([mallory.link], 1);
    await store.write({ roots: statements, blobs: [mallory.bytes, ...cardSchema.blobs, ...blobs] });
    expect(await namesByName(store, writtenNames())).toEqual([]);
  });

  it("reads on a later scan only what was recorded since, among statements of other schemas", async () => {
    const { store } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const readNames: string[] = [];
    const index = indexOver(selectedRecords(writtenObjectsOver(objectsOf(cardSchema))), namedSchema, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name, at: 0 }];
    });
    await store.record(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await store.record(writtenObjectsOf([bob.link], 1));
    expect(await namesByName(store, index)).toEqual(["Bob"]);
    await store.record(batchOf([taken(bob, 2)]));
    await store.record(writtenObjectsOf([alice.link], 2));
    expect(await namesByName(store, index)).toEqual(["Alice", "Bob"]);
    expect(readNames).toEqual(["Bob", "Alice"]);
  });

  it("gives the rows of an object once that was written again, which is recorded with the time of each", async () => {
    const { store } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const index = indexOver(selectedRecords(writtenObjectsOver(objectsOf(cardSchema))), namedSchema, ({ data }) => [
      { name: data.name, at: 0 },
    ]);
    await store.record(writtenObjectsOf([alice.link], 1));
    await store.record(writtenObjectsOf([alice.link], 1));
    expect(await namesByName(store, index)).toEqual(["Alice"]);
    await store.record(writtenObjectsOf([alice.link], 2));
    expect(await namesByName(store, index)).toEqual(["Alice"]);
    const writtenObjects = objectsOf(writtenObjectSchema);
    const times: number[] = [];
    for await (const statement of store.records())
      times.push((await writtenObjects.read(statement, store))?.data.at ?? -1);
    expect(times).toEqual([1, 2]);
  });
});

describe("an index over blobs", () => {
  it("reads the statements recorded among those that came to the store", async () => {
    const { store } = sides();
    const alice = card("Alice");
    const sentStatement = taken(alice, 0);
    await store.write({
      roots: [sentStatement.link],
      blobs: [sentStatement.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    await store.record(batchOf([taken(alice, 1)]));
    const index = indexOver(selectedBlobs(objectsOf(takenSchema)), namedSchema, ({ data }) => [
      { name: "", at: data.at },
    ]);
    const rows = await listOf((await store.scan(index)).orderedBy("at").range([]));
    expect(rows.map(({ data }) => data.at)).toEqual([0, 1]);
  });
});
