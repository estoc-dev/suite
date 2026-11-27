import {
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { link, optional, schema, string } from "@estoc/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  anyMemberObject,
  type Index,
  indexOfRows,
  indexOver,
  MemoryBackend,
  memberObjectOf,
  Store,
} from "../src/index.ts";

const place = schema("Place", { city: string() });
const route = schema("Route", { from: link(), to: link() });
const trip = schema("Trip", { name: string(), route: link() });
const schemas = [place, route, trip].flatMap(({ blobs }) => blobs);

const tripRow = schema("Trip Row", { name: string(), stop: link() });
const memberTrip = memberObjectOf(trip);
const trips = indexOfRows(tripRow, { name: memberTrip.field("name"), stop: memberTrip.field("route") });
const stops = trips.rowsOfEachLinkFrom("stop");

const lisbon = encodeObject(place, { city: "Lisbon" });
const porto = encodeObject(place, { city: "Porto" });
const faro = encodeObject(place, { city: "Faro" });
const northward = encodeObject(route, { from: new LinkValue(lisbon.link), to: new LinkValue(porto.link) });
const southward = encodeObject(route, { from: new LinkValue(lisbon.link), to: new LinkValue(faro.link) });
const north = encodeObject(trip, { name: "north", route: new LinkValue(northward.link) });
const south = encodeObject(trip, { name: "south", route: new LinkValue(southward.link) });
const places = [lisbon, porto, faro];

const batchOf = (...objects: readonly EncodedObject[]) => ({
  roots: objects.map(({ link }) => link),
  blobs: [...[...objects, northward, southward, ...places].map(({ bytes }) => bytes), ...schemas],
});

async function storeHolding(...objects: readonly EncodedObject[]): Promise<Store> {
  const store = new Store(new MemoryBackend());
  await store.write(batchOf(...objects));
  return store;
}

async function rowsOf<F extends ValueMap>(rows: AsyncIterable<EncodedObject<F>>): Promise<F[]> {
  const listed: F[] = [];
  for await (const { data } of rows) listed.push(data);
  return listed;
}

type RowOf<I> = I extends Index<infer F> ? F : never;

type Stop = { readonly name: string; readonly stop: LinkValue<unknown> };

const stopsIn = async (store: Pick<Store, "scan">, index: Index<Stop>, name: string) =>
  (await rowsOf(await store.scan(index)))
    .filter((row) => row.name === name)
    .map(({ stop }) => stop.link)
    .sort();

const linksWrittenIn = (bytes: Uint8Array): Link<unknown>[] => [...objectFormat.links(objectFormat.decode(bytes))];

describe("the rows of an index of each link from what a field links to", () => {
  it("are one of each link written in the object linked to, that of its schema among them, with the other fields as they are", async () => {
    const store = await storeHolding(north, south);
    const rows = await store.scan(stops);
    expect(await stopsIn(store, stops, "north")).toEqual([route.link, lisbon.link, porto.link].sort());
    expect(await stopsIn(store, stops, "south")).toEqual([route.link, lisbon.link, faro.link].sort());
    expect(await rowsOf(rows)).toHaveLength(6);
    expect(rows.failures).toEqual([]);
  });

  it("are none of a row that links to a blob that is not an object", async () => {
    const image = new TextEncoder().encode("an image");
    const pictured = encodeObject(trip, { name: "pictured", route: new LinkValue(linkOf(image)) });
    const store = await storeHolding(north);
    await store.write({ roots: [pictured.link], blobs: [pictured.bytes, image] });
    expect((await rowsOf(await store.scan(trips))).map(({ name }) => name).sort()).toEqual(["north", "pictured"]);
    expect((await rowsOf(await store.scan(stops))).map(({ name }) => name)).not.toContain("pictured");
  });

  it("are one of a link that the object holds twice", async () => {
    const around = encodeObject(route, { from: new LinkValue(lisbon.link), to: new LinkValue(lisbon.link) });
    const round = encodeObject(trip, { name: "round", route: new LinkValue(around.link) });
    const store = await storeHolding(north);
    await store.write({ roots: [round.link], blobs: [round.bytes, around.bytes] });
    expect(await stopsIn(store, stops, "round")).toEqual([route.link, lisbon.link].sort());
  });

  it("are the links written in an object where the field holds its own link, and none of a blob that is not an object", async () => {
    const linked = schema("Linked", { source: link(), target: link() });
    const links = indexOfRows(linked, {
      source: anyMemberObject.link,
      target: anyMemberObject.link,
    }).rowsOfEachLinkFrom("target");
    const image = new TextEncoder().encode("an image");
    const store = await storeHolding(north);
    await store.write({ roots: [linkOf(image)], blobs: [image] });
    const rows = await rowsOf(await store.scan(links));
    const targetsFrom = (source: Link<unknown>) =>
      rows.filter((row) => row.source.link === source).map(({ target }) => target.link);
    expect(targetsFrom(north.link).sort()).toEqual([trip.link, northward.link].sort());
    expect(targetsFrom(lisbon.link)).toEqual([place.link]);
    expect(targetsFrom(linkOf(image))).toEqual([]);
  });

  it("fail the scan where the store does not hold a blob that a row links to", async () => {
    const absent = linkOf(new TextEncoder().encode("held by no store"));
    const astray = indexOver(trips, tripRow, ({ data: { name } }) => [{ name, stop: new LinkValue(absent) }]);
    const store = await storeHolding(north);
    await expect(store.scan(astray.rowsOfEachLinkFrom("stop"))).rejects.toThrow(`the store does not hold ${absent}`);
  });

  it("are of what is two links away where they are asked of one field twice", async () => {
    const store = await storeHolding(north);
    const twoAway = [...new Set([...linksWrittenIn(route.bytes), place.link])].sort();
    expect(await stopsIn(store, stops.rowsOfEachLinkFrom("stop"), "north")).toEqual(twoAway);
  });

  it("are every pairing where they are asked of two fields", async () => {
    const pair = schema("Pair", { left: link(), right: link() });
    const memberRoute = memberObjectOf(route);
    const pairs = indexOfRows(pair, { left: memberRoute.link, right: memberRoute.link })
      .rowsOfEachLinkFrom("left")
      .rowsOfEachLinkFrom("right");
    const store = await storeHolding(north);
    const written = [route.link, lisbon.link, porto.link];
    const pairings = written.flatMap((left) => written.map((right) => `${left} ${right}`));
    const listed = (await rowsOf(await store.scan(pairs))).map(({ left, right }) => `${left.link} ${right.link}`);
    expect(listed.sort()).toEqual(pairings.sort());
  });

  it("are filtered and taken links of as the rows of any index are", async () => {
    const store = await storeHolding(north, south);
    const toPorto = stops.rowsWhere("stop", new LinkValue(porto.link));
    expect((await rowsOf(await store.scan(toPorto))).map(({ name }) => name)).toEqual(["north"]);
    const cities = indexOfRows(place, { city: memberObjectOf(place).field("city") }).reading(stops.linksAt("stop"));
    expect((await rowsOf(await store.scan(cities))).map(({ city }) => city).sort()).toEqual([
      "Faro",
      "Lisbon",
      "Porto",
    ]);
  });

  it("are rows of the schema of the index read, with a link to anything under the field", () => {
    const named = schema("Named", { name: string(), schema: link<Schema>() });
    const schemaNames = indexOfRows(named, { name: memberTrip.field("name"), schema: memberTrip.schema });
    const linked = schemaNames.rowsOfEachLinkFrom("schema");
    expect(linked.rowSchema).toBe(schemaNames.rowSchema);
    expectTypeOf<RowOf<typeof linked>>().toEqualTypeOf<{
      readonly name: string;
      readonly schema: LinkValue<unknown>;
    }>();
  });

  it("hold a link to anything under every field that holds a link, and what the rows read hold under the others", () => {
    const numbered = schema("Numbered", { 10: link<Schema>(), named: link<Schema>(), title: string() });
    const linked = indexOfRows(numbered, {
      10: memberTrip.schema,
      named: memberTrip.schema,
      title: memberTrip.field("name"),
    }).rowsOfEachLinkFrom("10");
    expectTypeOf<RowOf<typeof linked>>().toEqualTypeOf<{
      readonly 10: LinkValue<unknown>;
      readonly named: LinkValue<unknown>;
      readonly title: string;
    }>();
  });

  it("hold a link to anything under a field whose name is put together where the index is made", () => {
    const rowsWithField = (field: string) => {
      const fields = schema("Named Fields", { [field]: link<Schema>() });
      return indexOfRows(fields, { [field]: memberTrip.schema });
    };
    const linkedAt = (slot: number) => rowsWithField(`stop${slot}`).rowsOfEachLinkFrom(`stop${slot}`);
    type Linked = RowOf<ReturnType<typeof linkedAt>>;
    expectTypeOf<Linked[string]>().toEqualTypeOf<LinkValue<unknown>>();
    expectTypeOf<Linked[number]>().toEqualTypeOf<LinkValue<unknown>>();
  });

  it("have among their failures what the index read failed on", async () => {
    const misfit = objectFormat.encode(new ObjectValue(trip.link, { name: 1 }));
    const store = await storeHolding(north);
    await store.write({ roots: [linkOf(misfit)], blobs: [misfit] });
    const rows = await store.scan(stops);
    expect(await rowsOf(rows)).toHaveLength(3);
    expect(rows.failures).toEqual((await store.scan(trips)).failures);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });

  it("hold on a later scan those of what was written since", async () => {
    const store = await storeHolding(north);
    expect(await stopsIn(store, stops, "south")).toEqual([]);
    await store.write(batchOf(south));
    expect(await stopsIn(store, stops, "south")).toEqual([route.link, lisbon.link, faro.link].sort());
    expect(await stopsIn(store, stops, "north")).toEqual([route.link, lisbon.link, porto.link].sort());
  });

  it("hold over a staged batch those of the batch as well, which its store has not", async () => {
    const store = await storeHolding(north);
    const stagedStore = await store.stage(batchOf(south));
    expect(await stopsIn(stagedStore, stops, "south")).toEqual([route.link, lisbon.link, faro.link].sort());
    expect(await stopsIn(stagedStore, stops, "north")).toEqual([route.link, lisbon.link, porto.link].sort());
    expect(await stopsIn(store, stops, "south")).toEqual([]);
  });

  it("are of an index with no definition, where the index read has one", () => {
    expect(trips.definition).toBeDefined();
    expect(stops.definition).toBeUndefined();
  });

  it("are refused where the rows have no such field", () => {
    const stopped = indexOver(trips, schema("Stopped", { stop: link() }), () => []);
    // The compiler takes a name typed as a string where every field of the rows is a link.
    const misspelled: string = "stpo";
    expect(() => stopped.rowsOfEachLinkFrom(misspelled)).toThrow("a row of Stopped may hold no link under stpo");
  });

  it("are refused where the field is not a link", () => {
    // @ts-expect-error A string links to nothing.
    expect(() => trips.rowsOfEachLinkFrom("name")).toThrow("a row of Trip Row may hold no link under name");
  });

  it("are refused where a row may leave the field out", () => {
    const noted = schema("Noted", { name: string(), stop: optional(link()) });
    const notedTrips = indexOver(trips, noted, ({ data: { name } }) => [{ name }]);
    // @ts-expect-error A row that leaves the field out links to nothing.
    expect(() => notedTrips.rowsOfEachLinkFrom("stop")).toThrow("a row of Noted may hold no link under stop");
  });
});

const closureStops = trips.rowsOfEachInClosureAt("stop");

describe("the rows of an index of each blob in the closure of what a field links to", () => {
  it("are one of each blob in the closure, the blob linked to and the schemas among them, with the other fields as they are", async () => {
    const store = await storeHolding(north, south);
    const rows = await store.scan(closureStops);
    const shared = [route.link, ...linksWrittenIn(route.bytes), lisbon.link, place.link];
    expect(await stopsIn(store, closureStops, "north")).toEqual(
      [...new Set([northward.link, porto.link, ...shared])].sort(),
    );
    expect(await stopsIn(store, closureStops, "south")).toEqual(
      [...new Set([southward.link, faro.link, ...shared])].sort(),
    );
    expect(rows.failures).toEqual([]);
  });

  it("are one, of the blob itself, where the field links to a blob that is not an object", async () => {
    const image = new TextEncoder().encode("an image");
    const pictured = encodeObject(trip, { name: "pictured", route: new LinkValue(linkOf(image)) });
    const store = await storeHolding(north);
    await store.write({ roots: [pictured.link], blobs: [pictured.bytes, image] });
    expect(await stopsIn(store, closureStops, "pictured")).toEqual([linkOf(image)]);
  });

  it("are the closure of an object where the field holds its own link", async () => {
    const own = schema("Own", { root: link(), member: link() });
    const members = indexOfRows(own, { root: memberTrip.link, member: memberTrip.link }).rowsOfEachInClosureAt(
      "member",
    );
    const store = await storeHolding(north);
    const rows = await rowsOf(await store.scan(members));
    expect(new Set(rows.map(({ root }) => root.link))).toEqual(new Set([north.link]));
    expect(rows.map(({ member }) => member.link)).toContain(north.link);
    expect(rows.map(({ member }) => member.link)).toContain(porto.link);
  });

  it("fail the scan where the store does not hold a blob that a row links to", async () => {
    const absent = linkOf(new TextEncoder().encode("held by no store"));
    const astray = indexOver(trips, tripRow, ({ data: { name } }) => [{ name, stop: new LinkValue(absent) }]);
    const store = await storeHolding(north);
    await expect(store.scan(astray.rowsOfEachInClosureAt("stop"))).rejects.toThrow(`the store does not hold ${absent}`);
  });

  it("are rows of the schema of the index read, with a link to anything under every field that holds a link", () => {
    const named = schema("Named", { name: string(), schema: link<Schema>() });
    const schemaNames = indexOfRows(named, { name: memberTrip.field("name"), schema: memberTrip.schema });
    const linked = schemaNames.rowsOfEachInClosureAt("schema");
    expect(linked.rowSchema).toBe(schemaNames.rowSchema);
    expectTypeOf<RowOf<typeof linked>>().toEqualTypeOf<{
      readonly name: string;
      readonly schema: LinkValue<unknown>;
    }>();
  });

  it("have among their failures what the index read failed on", async () => {
    const misfit = objectFormat.encode(new ObjectValue(trip.link, { name: 1 }));
    const store = await storeHolding(north);
    await store.write({ roots: [linkOf(misfit)], blobs: [misfit] });
    const rows = await store.scan(closureStops);
    expect(rows.failures).toEqual((await store.scan(trips)).failures);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });

  it("hold on a later scan those of what was written since", async () => {
    const store = await storeHolding(north);
    expect(await stopsIn(store, closureStops, "south")).toEqual([]);
    await store.write(batchOf(south));
    expect(await stopsIn(store, closureStops, "south")).toContain(faro.link);
  });

  it("are of an index with no definition, where the index read has one", () => {
    expect(closureStops.definition).toBeUndefined();
  });

  it("are refused where the field is not a link", () => {
    // @ts-expect-error A string links to nothing.
    expect(() => trips.rowsOfEachInClosureAt("name")).toThrow("a row of Trip Row may hold no link under name");
  });
});
