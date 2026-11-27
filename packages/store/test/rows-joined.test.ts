import {
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type ValueMap,
} from "@estoc/object";
import { integer, link, schema, string } from "@estoc/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  anyMemberObject,
  type HeldBlob,
  heldBlobs,
  type Index,
  indexOver,
  linkedBlob,
  MemoryBackend,
  memberObjectOf,
  type Source,
  Store,
} from "../src/index.ts";

const place = schema("Place", { city: string() });
const route = schema("Route", { from: link(), to: link() });
const trip = schema("Trip", { name: string(), route: link() });
const schemas = [place, route, trip].flatMap(({ blobs }) => blobs);

const tripRow = schema("Trip Row", { name: string(), route: link() });
const ends = schema("Ends", { from: link(), to: link() });
const memberTrip = memberObjectOf(trip);
const memberRoute = memberObjectOf(route);
const trips = heldBlobs.rowsTaking(tripRow, { name: memberTrip.field("name"), route: memberTrip.field("route") });
const endPaths = { from: memberRoute.field("from"), to: memberRoute.field("to") };
const routeEnds = linkedBlob.rowsTaking(ends, endPaths);
const tripEnds = trips.rowsJoinedAt("route", routeEnds);

const lisbon = encodeObject(place, { city: "Lisbon" });
const porto = encodeObject(place, { city: "Porto" });
const faro = encodeObject(place, { city: "Faro" });
const northward = encodeObject(route, { from: new LinkValue(lisbon.link), to: new LinkValue(porto.link) });
const southward = encodeObject(route, { from: new LinkValue(lisbon.link), to: new LinkValue(faro.link) });
const north = encodeObject(trip, { name: "north", route: new LinkValue(northward.link) });
const south = encodeObject(trip, { name: "south", route: new LinkValue(southward.link) });

const batchOf = (...objects: readonly EncodedObject[]) => ({
  roots: objects.map(({ link }) => link),
  blobs: [...[...objects, northward, southward, lisbon, porto, faro].map(({ bytes }) => bytes), ...schemas],
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

const endsByName = async (store: Pick<Store, "scan">) =>
  Object.fromEntries(
    (await rowsOf(await store.scan(tripEnds))).map(({ name, route, from, to }) => [
      name,
      [route.link, from.link, to.link],
    ]),
  );

const tripTo = (name: string, routeLink: Link<unknown>) =>
  encodeObject(trip, { name, route: new LinkValue(routeLink) });

describe("the rows of an index joined to those of the blob that a field links to", () => {
  it("hold what the row holds and what the row of the blob linked to holds", async () => {
    const store = await storeHolding(north, south);
    const rows = await store.scan(tripEnds);
    expect(await endsByName(store)).toEqual({
      north: [northward.link, lisbon.link, porto.link],
      south: [southward.link, lisbon.link, faro.link],
    });
    expect(rows.failures).toEqual([]);
  });

  it("are none of a row that links to a blob that gives no row", async () => {
    const image = new TextEncoder().encode("an image");
    const toPlace = tripTo("to a place", lisbon.link);
    const pictured = tripTo("pictured", linkOf(image));
    const store = await storeHolding(north);
    await store.write({ roots: [toPlace.link, pictured.link], blobs: [toPlace.bytes, pictured.bytes, image] });
    expect(await rowsOf(await store.scan(trips))).toHaveLength(3);
    expect(Object.keys(await endsByName(store))).toEqual(["north"]);
    expect((await store.scan(tripEnds)).failures).toEqual([]);
  });

  it("are of a schema that has the fields of both and an empty title", () => {
    expect(tripEnds.rowSchema.document).toEqual({
      title: "",
      fields: { ...tripRow.document.fields, ...ends.document.fields },
    });
    expectTypeOf<RowOf<typeof tripEnds>>().toEqualTypeOf<RowOf<typeof trips> & RowOf<typeof routeEnds>>();
  });

  it("are of one schema where two joins come to the same fields", () => {
    const named = schema("Named", { name: string(), from: link() });
    const tos = schema("To", { to: link(), route: link() });
    const joined = heldBlobs
      .rowsTaking(named, { name: memberTrip.field("name"), from: memberTrip.field("route") })
      .rowsJoinedAt("from", linkedBlob.rowsTaking(tos, { to: memberRoute.field("to"), route: memberRoute.link }));
    expect(joined.rowSchema.link).toBe(tripEnds.rowSchema.link);
  });

  it("fail on the blob linked to where it gives a failure, once for each row that links to it, and keep the other rows", async () => {
    const misfit = objectFormat.encode(new ObjectValue(route.link, { from: 1 }));
    const [astray, lost] = [tripTo("astray", linkOf(misfit)), tripTo("lost", linkOf(misfit))];
    const store = await storeHolding(north);
    await store.write({ roots: [astray.link, lost.link], blobs: [astray.bytes, lost.bytes, misfit] });
    const rows = await store.scan(tripEnds);
    expect((await rowsOf(rows)).map(({ name }) => name)).toEqual(["north"]);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit), linkOf(misfit)]);
    expect((await store.scan(trips)).failures).toEqual([]);
  });

  it("have among their failures what the index read failed on", async () => {
    const misfit = objectFormat.encode(new ObjectValue(trip.link, { name: 1 }));
    const store = await storeHolding(north);
    await store.write({ roots: [linkOf(misfit)], blobs: [misfit] });
    const rows = await store.scan(tripEnds);
    expect(await rowsOf(rows)).toHaveLength(1);
    expect(rows.failures).toEqual((await store.scan(trips)).failures);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });

  it("fail the scan where the store does not hold a blob that a row links to", async () => {
    const absent = linkOf(new TextEncoder().encode("held by no store"));
    const astray = indexOver(trips, tripRow, ({ data: { name } }) => [{ name, route: new LinkValue(absent) }]);
    const store = await storeHolding(north);
    await expect(store.scan(astray.rowsJoinedAt("route", routeEnds))).rejects.toThrow(
      `the store does not hold ${absent}`,
    );
  });

  it("are joined again at a field that the join brought", async () => {
    const origin = schema("Origin", { city: string() });
    const origins = linkedBlob.rowsTaking(origin, { city: memberObjectOf(place).field("city") });
    const store = await storeHolding(north, south);
    const rows = await rowsOf(
      await store.scan(
        tripEnds
          .rowsJoinedAt("from", origins)
          .rowsJoinedAt(
            "to",
            linkedBlob.rowsTaking(schema("End", { end: string() }), { end: memberObjectOf(place).field("city") }),
          ),
      ),
    );
    expect(rows.map(({ name, city, end }) => `${name}: ${city} to ${end}`).sort()).toEqual([
      "north: Lisbon to Porto",
      "south: Lisbon to Faro",
    ]);
  });

  it("are filtered, and have fields taken of them, as the rows of any index", async () => {
    const store = await storeHolding(north, south);
    const toFaro = tripEnds.rowsWhere("to", new LinkValue(faro.link));
    const joinedRow = memberObjectOf(toFaro.rowSchema);
    const names = toFaro.rowsTaking(schema("Trip Name", { name: string() }), { name: joinedRow.field("name") });
    expect(await rowsOf(await store.scan(names))).toEqual([{ name: "south" }]);
  });

  it("hold on a later scan those of what was written since", async () => {
    const store = await storeHolding(north);
    expect(Object.keys(await endsByName(store))).toEqual(["north"]);
    await store.write(batchOf(south));
    expect(Object.keys(await endsByName(store)).sort()).toEqual(["north", "south"]);
  });

  it("hold over a staged batch those of the batch as well, which its store has not", async () => {
    const store = await storeHolding(north);
    const stagedStore = await store.stage(batchOf(south));
    expect(Object.keys(await endsByName(stagedStore)).sort()).toEqual(["north", "south"]);
    expect(Object.keys(await endsByName(store))).toEqual(["north"]);
  });

  it("are of an index with no definition, where both of those joined have one", () => {
    expect(trips.definition).toBeDefined();
    expect(routeEnds.definition).toBeDefined();
    expect(tripEnds.definition).toBeUndefined();
  });

  it("are refused where both have a field of one name", () => {
    const routed = schema("Routed", { route: link(), to: link() });
    const routes = linkedBlob.rowsTaking(routed, { route: memberRoute.link, to: memberRoute.field("to") });
    expect(() => trips.rowsJoinedAt("route", routes)).toThrow("the rows joined both have a field route");
  });

  it("are refused where the field is not a link", () => {
    // @ts-expect-error A string links to nothing.
    expect(() => trips.rowsJoinedAt("name", routeEnds)).toThrow("a row of Trip Row may hold no link under name");
  });

  it("are refused where what they are joined to reads anything but linkedBlob, an index that reads it among them", () => {
    const refusal = "this one reads something else";
    expect(() => trips.rowsJoinedAt("route", heldBlobs.rowsTaking(ends, endPaths))).toThrow(refusal);
    expect(() => trips.rowsJoinedAt("route", routeEnds.rowsWhere("to", new LinkValue(faro.link)))).toThrow(refusal);
    expect(() => trips.rowsJoinedAt("route", routeEnds.union(heldBlobs.rowsTaking(ends, endPaths)))).toThrow(refusal);
  });

  it("hold the rows of every part where what they are joined to is a union", async () => {
    const turned = linkedBlob.rowsTaking(ends, { from: memberRoute.field("to"), to: memberRoute.field("from") });
    const store = await storeHolding(north);
    const rows = await rowsOf(await store.scan(trips.rowsJoinedAt("route", routeEnds.union(turned))));
    expect(rows.map(({ from, to }) => [from.link, to.link]).sort()).toEqual(
      [
        [lisbon.link, porto.link],
        [porto.link, lisbon.link],
      ].sort(),
    );
  });

  it("hold, where one part of the union fails on the blob linked to, the rows and failures of a union of the joins to each part", async () => {
    const reference = schema("Reference", { reference: link() });
    const ofAnyObject = linkedBlob.rowsTaking(reference, { reference: anyMemberObject.link });
    const ofRoute = linkedBlob.rowsTaking(reference, { reference: memberRoute.link });
    const misfit = objectFormat.encode(new ObjectValue(route.link, { from: 1 }));
    const astray = tripTo("astray", linkOf(misfit));
    const store = await storeHolding(north);
    await store.write({ roots: [astray.link], blobs: [astray.bytes, misfit] });
    const scanned = async (index: Index<RowOf<typeof trips> & RowOf<typeof ofRoute>>) => {
      const rows = await store.scan(index);
      return {
        names: (await rowsOf(rows)).map(({ name }) => name).sort(),
        failedItems: rows.failures.map(({ item }) => item),
      };
    };
    const joinTo = (linked: typeof ofRoute) => trips.rowsJoinedAt("route", linked);
    const ofEachJoin = await scanned(joinTo(ofAnyObject).union(joinTo(ofRoute)));
    expect(ofEachJoin).toEqual({ names: ["astray", "north"], failedItems: [linkOf(misfit)] });
    expect(await scanned(joinTo(ofAnyObject.union(ofRoute)))).toEqual(ofEachJoin);
    expect(await scanned(joinTo(ofRoute.union(ofAnyObject)))).toEqual(ofEachJoin);
  });

  it("hold what a function gives of the blob linked to", async () => {
    const sized = schema("Sized", { size: integer() });
    const sizes = indexOver(linkedBlob, sized, ({ bytes }) => [{ size: bytes.length }]);
    const store = await storeHolding(north);
    expect(await rowsOf(await store.scan(trips.rowsJoinedAt("route", sizes)))).toEqual([
      { name: "north", route: new LinkValue(northward.link), size: northward.bytes.length },
    ]);
  });

  it("fail on the blob linked to where a function gives a row of it that does not fit, as the function fails over the blobs held", async () => {
    const counted = schema("Counted", { count: integer() });
    const countsOver = (source: Source<HeldBlob>) =>
      indexOver(source, counted, ({ bytes }) => {
        const count = Number(new TextDecoder().decode(bytes));
        return Number.isFinite(count) ? [{ count }] : [];
      });
    const whole = new TextEncoder().encode("2");
    const fraction = new TextEncoder().encode("1.5");
    const [toWhole, toFraction] = [tripTo("whole", linkOf(whole)), tripTo("fraction", linkOf(fraction))];
    const store = await storeHolding(north);
    await store.write({
      roots: [toWhole.link, toFraction.link],
      blobs: [toWhole.bytes, toFraction.bytes, whole, fraction],
    });
    const rows = await store.scan(trips.rowsJoinedAt("route", countsOver(linkedBlob)));
    expect(await rowsOf(rows)).toEqual([{ name: "whole", route: new LinkValue(linkOf(whole)), count: 2 }]);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(fraction)]);
    expect((await store.scan(countsOver(heldBlobs))).failures).toEqual(rows.failures);
  });

  it("fail the scan of what they are joined to, which a scan gives no blob", async () => {
    const store = await storeHolding(north);
    await expect(store.scan(routeEnds)).rejects.toThrow("a scan gives it no blob");
  });
});
