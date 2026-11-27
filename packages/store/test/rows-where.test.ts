import {
  decodeSchema,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type ValueMap,
} from "@estoc/object";
import { array, boolean, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  heldObjectsOf,
  type Index,
  indexOfRows,
  indexOver,
  MemoryBackend,
  memberObjectOf,
  Store,
} from "../src/index.ts";

const place = schema("Place", { city: string() });
const fields = { name: string(), count: integer(), isOpen: boolean(), home: link(), tags: array(string()) };
const shop = schema("Shop", fields);
const shopRow = schema("Shop Row", fields);
const schemas = [place, shop].flatMap(({ blobs }) => blobs);

const member = memberObjectOf(shop);
const shopRows = indexOfRows(shopRow, {
  name: member.field("name"),
  count: member.field("count"),
  isOpen: member.field("isOpen"),
  home: member.field("home"),
  tags: member.field("tags"),
});

const lisbon = encodeObject(place, { city: "Lisbon" });
const porto = encodeObject(place, { city: "Porto" });
const open = encodeObject(shop, { name: "open", count: 2, isOpen: true, home: new LinkValue(lisbon.link), tags: [] });
const shut = encodeObject(shop, { name: "shut", count: 3, isOpen: false, home: new LinkValue(porto.link), tags: [] });
const late = encodeObject(shop, { name: "late", count: 2, isOpen: false, home: new LinkValue(porto.link), tags: [] });

const batchOf = (...objects: readonly EncodedObject[]) => ({
  roots: objects.map(({ link }) => link),
  blobs: [...objects.map(({ bytes }) => bytes), lisbon.bytes, porto.bytes, ...schemas],
});

async function storeHolding(objects: readonly EncodedObject[], backend: Backend = new MemoryBackend()): Promise<Store> {
  const store = new Store(backend);
  await store.write(batchOf(...objects));
  return store;
}

async function rowsOf<F extends ValueMap>(rows: AsyncIterable<EncodedObject<F>>): Promise<EncodedObject<F>[]> {
  const listed: EncodedObject<F>[] = [];
  for await (const row of rows) listed.push(row);
  return listed;
}

const namesIn = async (store: Pick<Store, "scan">, index: Index<{ readonly name: string }>) =>
  (await rowsOf(await store.scan(index))).map(({ data }) => data.name).sort();

describe("the rows of an index where a field holds a value given", () => {
  it.each([
    ["a string", shopRows.rowsWhere("name", "open")],
    ["an integer", shopRows.rowsWhere("count", 2)],
    ["a boolean", shopRows.rowsWhere("isOpen", true)],
    ["a link, whichever value holds it", shopRows.rowsWhere("home", new LinkValue(lisbon.link))],
  ])("are those that hold it where it is %s, and no other", async (_, index) => {
    const store = await storeHolding([open, shut]);
    const rows = await store.scan(index);
    expect((await rowsOf(rows)).map(({ data }) => data)).toEqual([open.data]);
    expect(rows.failures).toEqual([]);
  });

  it("are rows of the schema of the index read, each with the link it has there", async () => {
    const index = shopRows.rowsWhere("count", 2);
    const store = await storeHolding([open, shut, late]);
    const linksOf = async (rows: Index<typeof open.data>) =>
      (await rowsOf(await store.scan(rows))).map(({ link }) => link);
    const openAndLate = [open, late].map(({ data }) => encodeObject(shopRow, data).link);
    expect((await linksOf(index)).sort()).toEqual(openAndLate.sort());
    expect(await linksOf(shopRows)).toEqual(expect.arrayContaining(openAndLate));
    expect(index.rowSchema).toBe(shopRows.rowSchema);
  });

  it("are those that hold each value where one is asked of the rows where another is held", async () => {
    const store = await storeHolding([open, shut, late]);
    expect(await namesIn(store, shopRows.rowsWhere("count", 2).rowsWhere("isOpen", false))).toEqual(["late"]);
  });

  it("are none where two values are asked of one field, and that is no failure", async () => {
    const store = await storeHolding([open, shut]);
    const rows = await store.scan(shopRows.rowsWhere("name", "open").rowsWhere("name", "shut"));
    expect(await rowsOf(rows)).toEqual([]);
    expect(rows.failures).toEqual([]);
  });

  it("are none of a row that leaves the field out", async () => {
    const noted = schema("Noted", { name: string(), note: optional(string()) });
    const notedShops = indexOver(shopRows, noted, ({ data: { name, isOpen } }) => [
      isOpen ? { name } : { name, note: "back soon" },
    ]);
    const store = await storeHolding([open, shut]);
    expect(await namesIn(store, notedShops.rowsWhere("note", "back soon"))).toEqual(["shut"]);
  });

  it("have among their failures what the index read failed on", async () => {
    const misfit = objectFormat.encode(new ObjectValue(shop.link, { name: 1 }));
    const store = await storeHolding([open]);
    await store.write({ roots: [linkOf(misfit)], blobs: [misfit] });
    const rows = await store.scan(shopRows.rowsWhere("name", "open"));
    expect(await rowsOf(rows)).toHaveLength(1);
    expect(rows.failures).toEqual((await store.scan(shopRows)).failures);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });

  it("are read from the rows kept of the index, without the store being asked for a blob", async () => {
    const backend = new MemoryBackend();
    const requestedLinks: Link<unknown>[] = [];
    const store = await storeHolding([open, shut], {
      get: (requested) => {
        requestedLinks.push(requested);
        return backend.get(requested);
      },
      has: (requested) => backend.has(requested),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    });
    await store.scan(shopRows);
    requestedLinks.length = 0;
    expect(await namesIn(store, shopRows.rowsWhere("isOpen", true))).toEqual(["open"]);
    expect(await namesIn(store, shopRows.rowsWhere("isOpen", false))).toEqual(["shut"]);
    expect(requestedLinks).toEqual([]);
  });

  it("hold on a later scan those of what was written since", async () => {
    const index = shopRows.rowsWhere("count", 2);
    const store = await storeHolding([open, shut]);
    expect(await namesIn(store, index)).toEqual(["open"]);
    await store.write(batchOf(late));
    expect(await namesIn(store, index)).toEqual(["late", "open"]);
  });

  it("hold over a staged batch those of the batch as well, which its store has not", async () => {
    const index = shopRows.rowsWhere("count", 2);
    const store = await storeHolding([open, shut]);
    const stagedStore = await store.stage(batchOf(late));
    expect(await namesIn(stagedStore, index)).toEqual(["late", "open"]);
    expect(await namesIn(store, index)).toEqual(["open"]);
  });

  it("are of an index with no definition, where the index read has one", () => {
    expect(shopRows.definition).toBeDefined();
    expect(shopRows.rowsWhere("name", "open").definition).toBeUndefined();
  });

  it("are refused where the rows have no such field", () => {
    // The compiler takes a name typed as a string where the fields of the rows are not said.
    const rowsOfAny: Index<Record<string, string>> = indexOver(shopRows, schema("Named", { name: string() }), () => []);
    expect(() => rowsOfAny.rowsWhere("nmae", "open")).toThrow("a row of Named has no field nmae");
  });

  it("are refused where the field is not a link, a string, an integer or a boolean", () => {
    // @ts-expect-error An array is not compared.
    expect(() => shopRows.rowsWhere("tags", [])).toThrow(
      "a row of Shop Row holds array under tags, and what is compared is a link, a string, an integer or a boolean",
    );
  });

  it("are refused where the value is of another type than the field", () => {
    // @ts-expect-error An integer is not the string that the rows hold.
    expect(() => shopRows.rowsWhere("name", 2)).toThrow(
      "a row of Shop Row holds string under name, and the value given is not one",
    );
    expect(() => shopRows.rowsWhere("count", 1.5)).toThrow(
      "a row of Shop Row holds integer under count, and the value given is not one",
    );
  });
});

describe("the objects of a schema among the blobs held", () => {
  const named = schema("Named", { name: string() });
  const shopNames = indexOfRows(named, { name: member.field("name") }).reading(heldObjectsOf(shop));
  const held = schema("Held", { object: link() });
  const heldShops = indexOver(heldObjectsOf(shop), held, ({ link }) => [{ object: new LinkValue(link) }]);
  const heldShopLinksIn = async (store: Store) =>
    (await rowsOf(await store.scan(heldShops))).map(({ data }) => data.object.link);
  const image = new TextEncoder().encode("an image");

  it("are those that name the schema, recorded or not, and no other blob", async () => {
    const store = new Store(new MemoryBackend());
    await store.record({ statements: [open.link], blobs: batchOf(open).blobs });
    await store.write({ roots: [shut.link, linkOf(image)], blobs: [...batchOf(shut).blobs, image] });
    expect((await heldShopLinksIn(store)).sort()).toEqual([open.link, shut.link].sort());
    expect(await namesIn(store, shopNames)).toEqual(["open", "shut"]);
  });

  it("hold one that names the schema and does not fit it, which an index that takes it as the schema fails on", async () => {
    const misfit = objectFormat.encode(new ObjectValue(shop.link, { name: 1 }));
    const store = await storeHolding([open]);
    await store.write({ roots: [linkOf(misfit)], blobs: [misfit] });
    const rows = await store.scan(shopNames);
    expect(await namesIn(store, shopNames)).toEqual(["open"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
    expect(await heldShopLinksIn(store)).toContain(linkOf(misfit));
  });

  it("are one source for one schema, whichever object holds the schema", () => {
    expect(heldObjectsOf(decodeSchema(shop.bytes))).toBe(heldObjectsOf(shop));
    expect(heldObjectsOf(place)).not.toBe(heldObjectsOf(shop));
  });
});
