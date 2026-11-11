import { encodeObject, json, type Link, linkOf, objectsOf, readObject } from "@estoc/object";
import { bytes, type DataOf, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { type Backend, type Index, indexOver, MemoryBackend, PrivateStore, Store, scan } from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  name: optional(string()),
  card: optional(link()),
  image: optional(link()),
  secret: optional(bytes()),
  leak: optional(link()),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);

function sides(sharedBackend: Backend = new MemoryBackend(), privateBackend: Backend = new MemoryBackend()) {
  const store = new Store(json, sharedBackend);
  return { store, privateStore: new PrivateStore(store, privateBackend) };
}

async function recordsOf(store: { records(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

describe("a private store", () => {
  it("gives what is kept in it and what the store beside it holds, and lists only what is written to it", async () => {
    const { store, privateStore } = sides();
    const card = object({ name: "Alice" });
    await store.write({ records: [card], blobs: anything.blobs });
    const secret = object({ card: { $link: card.link }, secret: "00" });
    await privateStore.write({ records: [secret] });
    expect(await privateStore.get(secret.link)).toEqual(secret.bytes);
    expect(await privateStore.get(card.link)).toEqual(card.bytes);
    expect(await recordsOf(privateStore)).toEqual([secret.link]);
    expect(await recordsOf(store)).toEqual([card.link]);
  });

  it("gives where it kept a blob, and nothing for one that only the store beside it holds", async () => {
    const { store, privateStore } = sides();
    const card = object({ name: "Alice" });
    await store.write({ records: [card], blobs: anything.blobs });
    const secret = object({ card: { $link: card.link }, secret: "00" });
    await privateStore.write({ records: [secret] });
    expect(await privateStore.positionOf(secret.link)).toBe(0);
    expect(await privateStore.positionOf(card.link)).toBeUndefined();
    expect(await store.positionOf(card.link)).toBe(2);
  });

  it("keeps in its backend nothing that the store beside it holds already", async () => {
    const backend = new MemoryBackend();
    const { store, privateStore } = sides(new MemoryBackend(), backend);
    const card = object({ name: "Alice" });
    await store.write({ records: [card], blobs: anything.blobs });
    const image = utf8("an image");
    const secret = object({ card: { $link: card.link }, image: { $link: linkOf(image) } });
    await privateStore.write({ records: [secret], blobs: [card.bytes, image, ...anything.blobs] });
    expect(await backend.has(secret.link)).toBe(true);
    expect(await backend.has(linkOf(image))).toBe(true);
    expect(await backend.has(card.link)).toBe(false);
    expect(await backend.has(anything.link)).toBe(false);
  });

  it("refuses a batch with a blob in a record's closure that neither the batch, it nor the store beside it holds", async () => {
    const { privateStore } = sides();
    const absent = object({ name: "absent" });
    const secret = object({ card: { $link: absent.link } });
    await expect(privateStore.write({ records: [secret], blobs: anything.blobs })).rejects.toThrow(
      `${secret.link} links to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await recordsOf(privateStore)).toEqual([]);
  });

  it("refuses to give a blob when the backend of the store beside it gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [card, other] = [object({ name: "Alice" }), object({ name: "Bob" })];
    await new Store(json, backend).write({ records: [card, other], blobs: anything.blobs });
    const { privateStore } = sides({
      get: (link) => backend.get(link === card.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, records) => backend.put(blobs, records),
      records: (start) => backend.records(start),
      blobs: (start) => backend.blobs(start),
      positionOf: (link) => backend.positionOf(link),
    });
    await expect(privateStore.get(card.link)).rejects.toThrow(`another blob under ${card.link}`);
  });

  it("is refused beside a store not made by `new Store`", () => {
    const store = new Store(json, new MemoryBackend());
    const lookalike: Store = {
      get: <T>(link: Link<T>) => store.get(link),
      write: (batch) => store.write(batch),
      stage: (batch) => store.stage(batch),
      records: () => store.records(),
      positionOf: (link) => store.positionOf(link),
      closure: (link) => store.closure(link),
    };
    expect(() => new PrivateStore(lookalike, new MemoryBackend())).toThrow(TypeError);
  });

  it("cannot be given as a store, nor a store as it", () => {
    const { store, privateStore } = sides();
    // @ts-expect-error: a private store has no closure to bundle what it keeps
    const asStore: Store = privateStore;
    // @ts-expect-error: a store would carry in bundles what is written to it
    const asPrivate: PrivateStore = store;
    expect(asStore).toBe(privateStore);
    expect(asPrivate).toBe(store);
  });

  it("can be scanned for an index, which reads through it what the store beside it holds", async () => {
    const { store, privateStore } = sides();
    const card = object({ name: "Alice" });
    await store.write({ records: [card], blobs: anything.blobs });
    await privateStore.write({ records: [object({ card: { $link: card.link } })] });
    const byName: Index<[name: string]> = indexOver(objectsOf(anything), async function* ({ data }, reader) {
      if (data.card === undefined) return;
      const { name } = (await readObject(reader, data.card.$link, anything)).data;
      if (name !== undefined) yield [name];
    });
    const rows: (readonly [string])[] = [];
    for await (const row of (await scan(privateStore, byName)).range([])) rows.push(row);
    expect(rows).toEqual([["Alice"]]);
  });
});

describe("the store beside a private store", () => {
  it("does not give, gather or list what is kept in the private store", async () => {
    const { store, privateStore } = sides();
    const card = object({ name: "Alice" });
    await store.write({ records: [card], blobs: anything.blobs });
    const secret = object({ card: { $link: card.link } });
    await privateStore.write({ records: [secret] });
    expect(await store.get(secret.link)).toBeUndefined();
    await expect(store.closure(secret.link)).rejects.toThrow(`the store does not hold ${secret.link}`);
    expect(await recordsOf(store)).toEqual([card.link]);
  });

  it("refuses to write anything with a blob kept in the private store in its closure", async () => {
    const { store, privateStore } = sides();
    const secret = object({ secret: "00" });
    await privateStore.write({ records: [secret], blobs: anything.blobs });
    const leak = object({ leak: { $link: secret.link } });
    await expect(store.write({ records: [leak], blobs: anything.blobs })).rejects.toThrow(
      `${leak.link} links to ${secret.link}, which neither the batch nor the store holds`,
    );
    expect(await recordsOf(store)).toEqual([]);
  });
});
