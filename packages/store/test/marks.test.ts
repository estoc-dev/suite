import { type EncodedObject, encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { integer, link, schema, secretSchema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  indexOver,
  Marks,
  MemoryBackend,
  RefusedBatch,
  recordSchema,
  recordsOf,
  Secrets,
  Store,
  scan,
  selectedBlobs,
  selectedMarks,
  selectedRecords,
  view,
} from "../src/index.ts";

const cardSchema = schema("Card", { name: string() });
// A mark as a program writes one: that it took a card, and when.
const takenSchema = schema("Taken", { card: link(), at: integer() });
const shownSchema = schema("Shown", { card: link() });
const card = (name: string) => encodeObject(cardSchema, { name });
const taken = (of: { readonly link: Link<unknown> }, at: number) =>
  encodeObject(takenSchema, { card: new LinkValue(of.link), at });
const utf8 = (text: string) => new TextEncoder().encode(text);
const batchOf = (marks: readonly EncodedObject[], blobs: readonly Uint8Array[] = []) => ({
  marks: marks.map(({ link }) => link),
  blobs: [...marks.map(({ bytes }) => bytes), ...blobs],
});

function sides() {
  const backend = new MemoryBackend();
  return { backend, store: new Store(backend), marks: new Marks(backend) };
}

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

const namedSchema = schema("Named", { name: string(), at: integer() });
const takenNames = () =>
  indexOver(selectedMarks(objectsOf(takenSchema)), namedSchema, async function* ({ data }, reader) {
    yield { name: (await readObject(reader, data.card.link, cardSchema)).data.name, at: data.at };
  }).orderedBy("at");

async function namesIn(store: Store, index = takenNames()): Promise<string[]> {
  const names: string[] = [];
  for await (const { data } of (await scan(store, index)).range([])) names.push(data.name);
  return names;
}

describe("marks", () => {
  it("are listed by the store in the order they were written, which gives them as any blob", async () => {
    const { store, marks } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const [first, second] = [taken(bob, 1), taken(alice, 2)];
    await marks.write(batchOf([first], [...takenSchema.blobs]));
    await marks.write(batchOf([second]));
    expect(await store.get(first.link)).toEqual(first.bytes);
    expect(await listOf(store.marks())).toEqual([first.link, second.link]);
    expect(await listOf(store.blobs())).toContain(first.link);
  });

  it("are listed once each, however often one is written", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await marks.write(batchOf([mark, mark], [...takenSchema.blobs]));
    await marks.write(batchOf([mark]));
    expect(await listOf(store.marks())).toEqual([mark.link]);
  });

  it("list an object that came to the store before it was written as a mark", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await store.write({
      roots: [alice.link, mark.link],
      blobs: [alice.bytes, mark.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    expect(await listOf(store.marks())).toEqual([]);
    await marks.write(batchOf([mark]));
    expect(await listOf(store.marks())).toEqual([mark.link]);
  });

  it("keep what the batch gives of a mark's closure, and drop the rest", async () => {
    const { backend, marks } = sides();
    const alice = card("Alice");
    const stray = utf8("not in the closure");
    await marks.write(batchOf([taken(alice, 1)], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs, stray]));
    expect(await backend.has(alice.link)).toBe(true);
    expect(await backend.has(takenSchema.link)).toBe(true);
    expect(await backend.has(linkOf(stray))).toBe(false);
  });

  it("refuse a batch with a blob in a mark's closure that neither the batch nor the store holds", async () => {
    const { store, marks } = sides();
    const absent = card("absent");
    const mark = taken(absent, 1);
    await expect(marks.write(batchOf([mark], [...takenSchema.blobs]))).rejects.toThrow(
      `${mark.link} links to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await listOf(store.marks())).toEqual([]);
  });

  it("refuse a mark that is not an object", async () => {
    const { marks } = sides();
    const image = utf8("an image");
    const refusal = marks.write({ marks: [linkOf(image)], blobs: [image] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${linkOf(image)} is written as a mark but is not an object`);
  });

  it("refuse a mark whose blob the batch does not give, though the store holds it", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await store.write({
      roots: [alice.link, mark.link],
      blobs: [alice.bytes, mark.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    const refusal = marks.write({ marks: [mark.link], blobs: [] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${mark.link} is written as a mark but is not among the blobs of the batch`);
    expect(await listOf(store.marks())).toEqual([]);
  });

  it("refuse a batch that gives a Secret in a mark's closure, and take one that the backend holds already", async () => {
    const { backend, store, marks } = sides();
    const secret = encodeObject(secretSchema, { bytes: Uint8Array.of(7) });
    const mark = taken(secret, 1);
    const refusal = marks.write(batchOf([mark], [secret.bytes, ...secretSchema.blobs, ...takenSchema.blobs]));
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${secret.link} is a Secret`);
    await new Secrets(backend).write({ roots: [secret.link], blobs: [secret.bytes, ...secretSchema.blobs] });
    await marks.write(batchOf([mark], [...takenSchema.blobs]));
    expect(await listOf(store.marks())).toEqual([mark.link]);
  });

  it("cannot be given as a store or as secrets, nor either of them as it", () => {
    const { backend, store, marks } = sides();
    const secrets = new Secrets(backend);
    // @ts-expect-error: what writes marks reads nothing
    const asStore: Store = marks;
    // @ts-expect-error: what writes marks reads no Secret
    const asSecrets: Secrets = marks;
    // @ts-expect-error: a store lists nothing, so that what came in a bundle marks nothing
    const fromStore: Marks = store;
    // @ts-expect-error: what writes Secrets lists nothing
    const fromSecrets: Marks = secrets;
    expect([asStore, asSecrets, fromStore, fromSecrets]).toEqual([marks, marks, store, secrets]);
  });
});

describe("a store that lists a mark", () => {
  it("refuses the closure of the mark, and of what links to it", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await marks.write(batchOf([mark], [...takenSchema.blobs]));
    const shown = encodeObject(shownSchema, { card: new LinkValue(mark.link) });
    await store.write({ roots: [shown.link], blobs: [shown.bytes, ...shownSchema.blobs] });
    await expect(store.closure(mark.link)).rejects.toThrow(
      `the closure of ${mark.link} reaches ${mark.link}, a mark, which stays in the store`,
    );
    await expect(store.closure(shown.link)).rejects.toThrow(
      `the closure of ${shown.link} reaches ${mark.link}, a mark, which stays in the store`,
    );
    expect([...(await store.closure(alice.link)).keys()]).toContain(alice.link);
  });

  it("refuses the closure of what came in with the bytes of the mark", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await marks.write(batchOf([mark], [alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs]));
    const shown = encodeObject(shownSchema, { card: new LinkValue(mark.link) });
    await store.write({ roots: [shown.link], blobs: [shown.bytes, mark.bytes, ...shownSchema.blobs] });
    await expect(store.closure(shown.link)).rejects.toThrow("a mark, which stays in the store");
  });

  it("gives the closure of an object that was written as a mark only since the closure was last read", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await store.write({
      roots: [mark.link],
      blobs: [mark.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    expect([...(await store.closure(mark.link)).keys()]).toContain(mark.link);
    await marks.write(batchOf([mark]));
    await expect(store.closure(mark.link)).rejects.toThrow("a mark, which stays in the store");
  });
});

describe("an index over marks", () => {
  it("reads the marks that its selection takes, and through them what the store holds", async () => {
    const { store, marks } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await marks.write(
      batchOf(
        [taken(bob, 1), taken(alice, 2), encodeObject(shownSchema, { card: new LinkValue(alice.link) })],
        [...takenSchema.blobs, ...shownSchema.blobs],
      ),
    );
    expect(await namesIn(store)).toEqual(["Bob", "Alice"]);
  });

  it("reads no object of the schema of a mark that only came to the store", async () => {
    const { store, marks } = sides();
    const [alice, mallory] = [card("Alice"), card("Mallory")];
    const sentMark = taken(mallory, 0);
    await store.write({
      roots: [alice.link, sentMark.link],
      blobs: [alice.bytes, sentMark.bytes, mallory.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    expect(await namesIn(store)).toEqual([]);
    await marks.write(batchOf([taken(alice, 1)]));
    expect(await namesIn(store)).toEqual(["Alice"]);
  });

  it("reads on a later scan only the marks written since", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const readTimes: number[] = [];
    const index = indexOver(selectedMarks(objectsOf(takenSchema)), namedSchema, ({ data }) => {
      readTimes.push(data.at);
      return [{ name: "", at: data.at }];
    }).orderedBy("at");
    await marks.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await scan(store, index);
    await marks.write(batchOf([taken(alice, 2)]));
    expect((await listOf((await scan(store, index)).range([]))).map(({ data }) => data.at)).toEqual([1, 2]);
    expect(readTimes).toEqual([1, 2]);
  });

  it("fails the scan on a mark that its rows throw on", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    await marks.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    const index = indexOver(selectedMarks(objectsOf(takenSchema)), namedSchema, () => {
      throw new Error("not read");
    }).orderedBy("at");
    await expect(scan(store, index)).rejects.toThrow("not read");
  });

  it("gives a view its rows, with the store to read what they name", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    await marks.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    const latest = await view(store, {
      index: indexOver(selectedMarks(objectsOf(takenSchema)), takenSchema, ({ data }) => [data]).orderedBy("at"),
      read: async (rows, reader) => {
        const [row] = await listOf(rows.range([]));
        return row && (await readObject(reader, row.data.card.link, cardSchema)).data.name;
      },
    });
    expect(latest).toBe("Alice");
  });
});

describe("an index over records", () => {
  const recordedNames = () =>
    indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => [
      { name: data.name, at: 0 },
    ]).orderedBy("name");
  const namesByName = async (store: Store, index: ReturnType<typeof recordedNames>) =>
    (await listOf((await scan(store, index)).range([]))).map(({ data }) => data.name);

  it("reads the objects that the records among the marks link to", async () => {
    const { store, marks } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await marks.write(batchOf([taken(bob, 1)], [...takenSchema.blobs]));
    await marks.write(recordsOf([alice.link], 1));
    expect(await namesByName(store, recordedNames())).toEqual(["Alice"]);
  });

  it("reads no object whose record only came to the store", async () => {
    const { store } = sides();
    const mallory = card("Mallory");
    const { marks: records, blobs } = recordsOf([mallory.link], 1);
    await store.write({ roots: records, blobs: [mallory.bytes, ...cardSchema.blobs, ...blobs] });
    expect(await namesByName(store, recordedNames())).toEqual([]);
  });

  it("reads on a later scan only what was recorded since, among marks of other schemas", async () => {
    const { store, marks } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const readNames: string[] = [];
    const index = indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name, at: 0 }];
    }).orderedBy("name");
    await marks.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await marks.write(recordsOf([bob.link], 1));
    expect(await namesByName(store, index)).toEqual(["Bob"]);
    await marks.write(batchOf([taken(bob, 2)]));
    await marks.write(recordsOf([alice.link], 2));
    expect(await namesByName(store, index)).toEqual(["Alice", "Bob"]);
    expect(readNames).toEqual(["Bob", "Alice"]);
  });

  it("reads an object once that was recorded again, which is marked with the time of each", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const readNames: string[] = [];
    const index = indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name, at: 0 }];
    }).orderedBy("name");
    await marks.write(recordsOf([alice.link], 1));
    await marks.write(recordsOf([alice.link], 1));
    expect(await namesByName(store, index)).toEqual(["Alice"]);
    await marks.write(recordsOf([alice.link], 2));
    expect(await namesByName(store, index)).toEqual(["Alice"]);
    expect(readNames).toEqual(["Alice"]);
    const records = objectsOf(recordSchema);
    const times: number[] = [];
    for await (const mark of store.marks()) times.push((await records.read(mark, store))?.data.at ?? -1);
    expect(times).toEqual([1, 2]);
  });
});

describe("an index over blobs", () => {
  it("reads the blobs of marks among those that came to the store", async () => {
    const { store, marks } = sides();
    const alice = card("Alice");
    const sentMark = taken(alice, 0);
    await store.write({
      roots: [sentMark.link],
      blobs: [sentMark.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    await marks.write(batchOf([taken(alice, 1)]));
    const index = indexOver(selectedBlobs(objectsOf(takenSchema)), namedSchema, ({ data }) => [
      { name: "", at: data.at },
    ]).orderedBy("at");
    const rows = await listOf((await scan(store, index)).range([]));
    expect(rows.map(({ data }) => data.at)).toEqual([0, 1]);
  });
});
