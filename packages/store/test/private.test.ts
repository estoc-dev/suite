import { type EncodedObject, encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { integer, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  indexOver,
  MemoryBackend,
  PrivateStore,
  RefusedBatch,
  recordSchema,
  recordsOf,
  SecretStore,
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

function sides(sharedBackend: Backend = new MemoryBackend()) {
  const store = new Store(sharedBackend);
  const privateBackend = new MemoryBackend();
  return { store, privateBackend, privateStore: new PrivateStore(store, privateBackend) };
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

async function namesIn(store: Parameters<typeof scan>[0], index = takenNames()): Promise<string[]> {
  const names: string[] = [];
  for await (const { data } of (await scan(store, index)).range([])) names.push(data.name);
  return names;
}

describe("a private store", () => {
  it("gives what is kept in it and what the store beside it holds, and lists the marks in the order they were written", async () => {
    const { store, privateStore } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const [first, second] = [taken(bob, 1), taken(alice, 2)];
    await privateStore.write(batchOf([first], [...takenSchema.blobs]));
    await privateStore.write(batchOf([second]));
    expect(await privateStore.get(first.link)).toEqual(first.bytes);
    expect(await privateStore.get(alice.link)).toEqual(alice.bytes);
    expect(await listOf(privateStore.marks())).toEqual([first.link, second.link]);
  });

  it("lists a mark once, however often it is written", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await privateStore.write(batchOf([mark, mark], [...takenSchema.blobs]));
    await privateStore.write(batchOf([mark]));
    expect(await listOf(privateStore.marks())).toEqual([mark.link]);
  });

  it("keeps a mark that the store beside it holds already", async () => {
    const { store, privateBackend, privateStore } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await store.write({
      roots: [alice.link, mark.link],
      blobs: [alice.bytes, mark.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    await privateStore.write(batchOf([mark]));
    expect(await privateBackend.has(mark.link)).toBe(true);
    expect(await listOf(privateStore.marks())).toEqual([mark.link]);
  });

  it("keeps what the batch gives of a mark's closure, whether or not the store beside it holds that, and drops the rest", async () => {
    const { store, privateBackend, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const stray = utf8("not in the closure");
    await privateStore.write(batchOf([taken(alice, 1)], [alice.bytes, ...takenSchema.blobs, stray]));
    expect(await privateBackend.has(alice.link)).toBe(true);
    expect(await privateBackend.has(takenSchema.link)).toBe(true);
    expect(await privateBackend.has(linkOf(stray))).toBe(false);
  });

  it("takes a blob of a mark's closure that the batch leaves out as held when the store beside it holds it", async () => {
    const { store, privateBackend, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await privateStore.write(batchOf([mark], [...takenSchema.blobs]));
    expect(await privateBackend.has(alice.link)).toBe(false);
    expect(await listOf(privateStore.marks())).toEqual([mark.link]);
  });

  it("refuses a batch with a blob in a mark's closure that neither the batch, it nor the store beside it holds", async () => {
    const { privateStore } = sides();
    const absent = card("absent");
    const mark = taken(absent, 1);
    await expect(privateStore.write(batchOf([mark], [...takenSchema.blobs]))).rejects.toThrow(
      `${mark.link} links to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await listOf(privateStore.marks())).toEqual([]);
  });

  it("refuses a mark that is not an object", async () => {
    const { privateStore } = sides();
    const image = utf8("an image");
    const refusal = privateStore.write({ marks: [linkOf(image)], blobs: [image] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${linkOf(image)} is written as a mark but is not an object`);
  });

  it("refuses a mark whose blob the batch does not give, though the store beside it holds it", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    const mark = taken(alice, 1);
    await store.write({
      roots: [alice.link, mark.link],
      blobs: [alice.bytes, mark.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    const refusal = privateStore.write({ marks: [mark.link], blobs: [] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${mark.link} is written as a mark but is not among the blobs of the batch`);
    expect(await listOf(privateStore.marks())).toEqual([]);
  });

  it("refuses to give a blob when its backend gives other bytes under the link", async () => {
    const store = new Store(new MemoryBackend());
    const backend = new MemoryBackend();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const [mark, other] = [taken(alice, 1), taken(bob, 2)];
    await new PrivateStore(store, backend).write(batchOf([mark, other], [...takenSchema.blobs]));
    const privateStore = new PrivateStore(store, {
      get: (link) => backend.get(link === mark.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, listedLinks) => backend.put(blobs, listedLinks),
      listedLinks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
    await expect(privateStore.get(mark.link)).rejects.toThrow(`another blob under ${mark.link}`);
  });

  it("is refused beside a store not made by `new Store`", () => {
    const store = new Store(new MemoryBackend());
    const lookalike: Store = {
      get: <T>(link: Link<T>) => store.get(link),
      write: (batch) => store.write(batch),
      stage: (batch) => store.stage(batch),
      blobs: () => store.blobs(),
      closure: (link) => store.closure(link),
    };
    expect(() => new PrivateStore(lookalike, new MemoryBackend())).toThrow(TypeError);
  });

  it("cannot be given as a store or a secret store, nor either of them as it", () => {
    const { store, privateStore } = sides();
    const secretStore = new SecretStore(store, new MemoryBackend());
    // @ts-expect-error: a private store has no closure to bundle its marks
    const asStore: Store = privateStore;
    // @ts-expect-error: a secret is not kept among what a user's other devices take
    const asSecret: SecretStore = privateStore;
    // @ts-expect-error: a store would carry in bundles what is written to it
    const fromStore: PrivateStore = store;
    // @ts-expect-error: a secret store lists secrets, and stays on one device
    const fromSecret: PrivateStore = secretStore;
    expect([asStore, asSecret, fromStore, fromSecret]).toEqual([privateStore, privateStore, store, secretStore]);
  });
});

describe("the store beside a private store", () => {
  it("does not give, gather or list a mark", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await privateStore.write(batchOf([mark], [...takenSchema.blobs]));
    expect(await store.get(mark.link)).toBeUndefined();
    await expect(store.closure(mark.link)).rejects.toThrow(`the store does not hold ${mark.link}`);
    expect(await listOf(store.blobs())).not.toContain(mark.link);
  });

  it("refuses to write anything with a mark in its closure", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await privateStore.write(batchOf([mark], [...takenSchema.blobs]));
    const leak = encodeObject(shownSchema, { card: new LinkValue(mark.link) });
    await expect(store.write({ roots: [leak.link], blobs: [leak.bytes, ...shownSchema.blobs] })).rejects.toThrow(
      `${leak.link} links to ${mark.link}, which neither the batch nor the store holds`,
    );
  });
});

describe("an index over marks", () => {
  it("reads the marks that its selection takes, and through them what the store beside holds", async () => {
    const { store, privateStore } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await privateStore.write(
      batchOf(
        [taken(bob, 1), taken(alice, 2), encodeObject(shownSchema, { card: new LinkValue(alice.link) })],
        [...takenSchema.blobs, ...shownSchema.blobs],
      ),
    );
    expect(await namesIn(privateStore)).toEqual(["Bob", "Alice"]);
  });

  it("reads no object of the schema of a mark that came to the store beside", async () => {
    const { store, privateStore } = sides();
    const [alice, mallory] = [card("Alice"), card("Mallory")];
    const sentMark = taken(mallory, 0);
    await store.write({
      roots: [alice.link, sentMark.link],
      blobs: [alice.bytes, sentMark.bytes, mallory.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    await privateStore.write(batchOf([taken(alice, 1)]));
    expect(await namesIn(privateStore)).toEqual(["Alice"]);
    expect(await namesIn(store)).toEqual([]);
  });

  it("reads on a later scan only the marks written since", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const readTimes: number[] = [];
    const index = indexOver(selectedMarks(objectsOf(takenSchema)), namedSchema, ({ data }) => {
      readTimes.push(data.at);
      return [{ name: "", at: data.at }];
    }).orderedBy("at");
    await privateStore.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await scan(privateStore, index);
    await privateStore.write(batchOf([taken(alice, 2)]));
    expect((await listOf((await scan(privateStore, index)).range([]))).map(({ data }) => data.at)).toEqual([1, 2]);
    expect(readTimes).toEqual([1, 2]);
  });

  it("fails the scan on a mark that its rows throw on", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    await privateStore.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    const index = indexOver(selectedMarks(objectsOf(takenSchema)), namedSchema, () => {
      throw new Error("not read");
    }).orderedBy("at");
    await expect(scan(privateStore, index)).rejects.toThrow("not read");
  });

  it("gives a view its rows, with the private store to read what they name", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const mark = taken(alice, 1);
    await privateStore.write(batchOf([mark], [...takenSchema.blobs]));
    const latest = await view(privateStore, {
      index: indexOver(selectedMarks(objectsOf(takenSchema)), takenSchema, ({ data }) => [data]).orderedBy("at"),
      read: async (rows, reader) => {
        const [row] = await listOf(rows.range([]));
        return row && (await readObject(reader, row.data.card.link, cardSchema)).data.name;
      },
    });
    expect(latest).toBe("Alice");
  });
});

describe("an index over records, scanned on a private store", () => {
  const recordedNames = () =>
    indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => [
      { name: data.name, at: 0 },
    ]).orderedBy("name");
  const namesByName = async (privateStore: PrivateStore, index: ReturnType<typeof recordedNames>) =>
    (await listOf((await scan(privateStore, index)).range([]))).map(({ data }) => data.name);

  it("reads the objects that the records among the marks link to, which the store beside holds", async () => {
    const { store, privateStore } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    await privateStore.write(batchOf([taken(bob, 1)], [...takenSchema.blobs]));
    await privateStore.write(recordsOf([alice.link], 1));
    expect(await namesByName(privateStore, recordedNames())).toEqual(["Alice"]);
  });

  it("reads no object whose record came to the store beside", async () => {
    const { store, privateStore } = sides();
    const mallory = card("Mallory");
    const { marks, blobs } = recordsOf([mallory.link], 1);
    await store.write({ roots: marks, blobs: [mallory.bytes, ...cardSchema.blobs, ...blobs] });
    expect(await namesByName(privateStore, recordedNames())).toEqual([]);
  });

  it("reads on a later scan only what was recorded since, among marks of other schemas", async () => {
    const { store, privateStore } = sides();
    const [alice, bob] = [card("Alice"), card("Bob")];
    await store.write({ roots: [alice.link, bob.link], blobs: [alice.bytes, bob.bytes, ...cardSchema.blobs] });
    const readNames: string[] = [];
    const index = indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name, at: 0 }];
    }).orderedBy("name");
    await privateStore.write(batchOf([taken(alice, 1)], [...takenSchema.blobs]));
    await privateStore.write(recordsOf([bob.link], 1));
    expect(await namesByName(privateStore, index)).toEqual(["Bob"]);
    await privateStore.write(batchOf([taken(bob, 2)]));
    await privateStore.write(recordsOf([alice.link], 2));
    expect(await namesByName(privateStore, index)).toEqual(["Alice", "Bob"]);
    expect(readNames).toEqual(["Bob", "Alice"]);
  });

  it("reads an object once that was recorded again, which is marked with the time of each", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    await store.write({ roots: [alice.link], blobs: [alice.bytes, ...cardSchema.blobs] });
    const readNames: string[] = [];
    const index = indexOver(selectedRecords(objectsOf(cardSchema)), namedSchema, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name, at: 0 }];
    }).orderedBy("name");
    await privateStore.write(recordsOf([alice.link], 1));
    await privateStore.write(recordsOf([alice.link], 1));
    expect(await namesByName(privateStore, index)).toEqual(["Alice"]);
    await privateStore.write(recordsOf([alice.link], 2));
    expect(await namesByName(privateStore, index)).toEqual(["Alice"]);
    expect(readNames).toEqual(["Alice"]);
    const records = objectsOf(recordSchema);
    const times: number[] = [];
    for await (const mark of privateStore.marks()) times.push((await records.read(mark, privateStore))?.data.at ?? -1);
    expect(times).toEqual([1, 2]);
  });
});

describe("an index over blobs, scanned on a private store", () => {
  const rowsOf = ({ data }: { readonly data: { readonly at: number } }) => [{ name: "", at: data.at }];
  const takenBlobs = () => indexOver(selectedBlobs(objectsOf(takenSchema)), namedSchema, rowsOf).orderedBy("at");

  it("reads the blobs that the store beside holds, and none that only the private store keeps", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    const sentMark = taken(alice, 0);
    await store.write({
      roots: [sentMark.link],
      blobs: [sentMark.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    await privateStore.write(batchOf([taken(alice, 1)]));
    const rows = await listOf((await scan(privateStore, takenBlobs())).range([]));
    expect(rows.map(({ data }) => data.at)).toEqual([0]);
  });

  it("gives its rows with their failures, as on the store beside", async () => {
    const { store, privateStore } = sides();
    const alice = card("Alice");
    const sentMark = taken(alice, 0);
    await store.write({
      roots: [sentMark.link],
      blobs: [sentMark.bytes, alice.bytes, ...cardSchema.blobs, ...takenSchema.blobs],
    });
    const index = indexOver(selectedBlobs(objectsOf(takenSchema)), namedSchema, () => {
      throw new Error("not read");
    }).orderedBy("at");
    expect((await scan(privateStore, index)).failures.map(({ item }) => item)).toEqual([sentMark.link]);
  });
});
