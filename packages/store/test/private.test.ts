import {
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  json,
  type Link,
  linkOf,
  readObject,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Backend, type Index, MemoryBackend, PrivateStore, Store, scan } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);

function sides(shared: Backend = new MemoryBackend(), kept: Backend = new MemoryBackend()) {
  const store = new Store(json, shared);
  return { store, kept: new PrivateStore(store, kept) };
}

async function listed(store: { mine(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

describe("a private store", () => {
  it("gives what is kept in it and what the store beside it holds, and lists only what is written to it", async () => {
    const { store, kept } = sides();
    const card = object({ name: "Alice" });
    await store.write({ mine: [card], blobs: [anything.bytes] });
    const secret = object({ card: { $link: card.link }, secret: "00" });
    await kept.write({ mine: [secret] });
    expect(await kept.get(secret.link)).toEqual(secret.bytes);
    expect(await kept.get(card.link)).toEqual(card.bytes);
    expect(await listed(kept)).toEqual([secret.link]);
    expect(await listed(store)).toEqual([card.link]);
  });

  it("keeps in its backend nothing that the store beside it holds already", async () => {
    const backend = new MemoryBackend();
    const { store, kept } = sides(new MemoryBackend(), backend);
    const card = object({ name: "Alice" });
    await store.write({ mine: [card], blobs: [anything.bytes] });
    const image = utf8("an image");
    const secret = object({ card: { $link: card.link }, image: { $link: linkOf(image) } });
    await kept.write({ mine: [secret], blobs: [card.bytes, image, anything.bytes] });
    expect(await backend.has(secret.link)).toBe(true);
    expect(await backend.has(linkOf(image))).toBe(true);
    expect(await backend.has(card.link)).toBe(false);
    expect(await backend.has(anything.link)).toBe(false);
  });

  it("refuses a batch that leads to a blob that neither the batch, it nor the store beside it holds", async () => {
    const { kept } = sides();
    const absent = object({ name: "absent" });
    const secret = object({ card: { $link: absent.link } });
    await expect(kept.write({ mine: [secret], blobs: [anything.bytes] })).rejects.toThrow(
      `${secret.link} leads to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await listed(kept)).toEqual([]);
  });

  it("refuses to give a blob when the backend of the store beside it gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [card, other] = [object({ name: "Alice" }), object({ name: "Bob" })];
    await new Store(json, backend).write({ mine: [card, other], blobs: [anything.bytes] });
    const { kept } = sides({
      get: (link) => backend.get(link === card.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, mine) => backend.put(blobs, mine),
      mine: () => backend.mine(),
    });
    await expect(kept.get(card.link)).rejects.toThrow(`another blob under ${card.link}`);
  });

  it("is refused beside a store not made by `new Store`", () => {
    const store = new Store(json, new MemoryBackend());
    const lookalike: Store = {
      get: <T>(link: Link<T>) => store.get(link),
      write: (batch) => store.write(batch),
      mine: () => store.mine(),
      closure: (link) => store.closure(link),
    };
    expect(() => new PrivateStore(lookalike, new MemoryBackend())).toThrow(TypeError);
  });

  it("cannot be given as a store, nor a store as it", () => {
    const { store, kept } = sides();
    // @ts-expect-error: a private store has no closure to bundle what it keeps
    const asStore: Store = kept;
    // @ts-expect-error: a store would carry in bundles what is written to it
    const asPrivate: PrivateStore = store;
    expect(asStore).toBe(kept);
    expect(asPrivate).toBe(store);
  });

  it("can be scanned for an index, which reads through it what the store beside it holds", async () => {
    const { store, kept } = sides();
    const card = object({ name: "Alice" });
    await store.write({ mine: [card], blobs: [anything.bytes] });
    await kept.write({ mine: [object({ card: { $link: card.link } })] });
    const byName: Index<Json, [name: string]> = {
      reads: [anything],
      async *rows({ data }, reader) {
        const { card } = data as { card: { $link: Link<unknown> } };
        const { name } = (await readObject(reader, card.$link, anything)).data as { name: string };
        yield [name];
      },
    };
    const rows: (readonly [string])[] = [];
    for await (const row of (await scan(kept, byName)).range([])) rows.push(row);
    expect(rows).toEqual([["Alice"]]);
  });
});

describe("the store beside a private store", () => {
  it("does not give, gather or list what is kept in the private store", async () => {
    const { store, kept } = sides();
    const card = object({ name: "Alice" });
    await store.write({ mine: [card], blobs: [anything.bytes] });
    const secret = object({ card: { $link: card.link } });
    await kept.write({ mine: [secret] });
    expect(await store.get(secret.link)).toBeUndefined();
    expect((await store.closure(secret.link)).size).toBe(0);
    expect(await listed(store)).toEqual([card.link]);
  });

  it("refuses to write anything that leads to a blob kept in the private store", async () => {
    const { store, kept } = sides();
    const secret = object({ secret: "00" });
    await kept.write({ mine: [secret], blobs: [anything.bytes] });
    const leak = object({ secret: { $link: secret.link } });
    await expect(store.write({ mine: [leak], blobs: [anything.bytes] })).rejects.toThrow(
      `${leak.link} leads to ${secret.link}, which neither the batch nor the store holds`,
    );
    expect(await listed(store)).toEqual([]);
  });
});
