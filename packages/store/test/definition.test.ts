import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  objectsOf,
  rootSchema,
  type Schema,
  SelectionBySchema,
} from "@estoc/object";
import { array, integer, link, optional, schema, string } from "@estoc/schema";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  anyMemberObject,
  type Backend,
  type Index,
  type IndexDefinition,
  indexOfRows,
  indexOver,
  MemoryBackend,
  memberObjectOf,
  recordedStatements,
  recordSchema,
  Store,
  selectedRecords,
  type ValuePath,
} from "../src/index.ts";

const place = schema("Place", { city: string() });
const person = schema("Person", { name: string(), home: link(), nickname: optional(string()) });
const card = schema("Card", { title: string(), owner: link(), tags: array(string()) });
const schemas = [place, person, card].flatMap(({ blobs }) => blobs);

const ownedCard = schema("Owned Card", { card: link(), title: string(), owner: string(), city: string() });
const titled = schema("Titled", { title: string() });

const memberCard = memberObjectOf(card);
const owner = memberCard.field("owner").objectOf(person);
const ownedCardsOfAll = indexOfRows(ownedCard, {
  card: memberCard.link,
  title: memberCard.field("title"),
  owner: owner.field("name"),
  city: owner.field("home").objectOf(place).field("city"),
});
const ownedCards = ownedCardsOfAll.reading(recordedStatements);

const lisbon = encodeObject(place, { city: "Lisbon" });
const ada = encodeObject(person, { name: "Ada", home: new LinkValue(lisbon.link) });
const cardOf = (title: string, owned: Link<unknown> = ada.link) =>
  encodeObject(card, { title, owner: new LinkValue(owned), tags: [] });
const closure = [lisbon.bytes, ada.bytes, ...schemas];

async function storeRecording(...statements: readonly EncodedObject[]): Promise<Store> {
  const store = new Store(new MemoryBackend());
  await store.record({
    statements: statements.map(({ link }) => link),
    blobs: [...statements.map(({ bytes }) => bytes), ...closure],
  });
  return store;
}

async function rowDataOf<F>(range: AsyncIterable<{ readonly data: F }>): Promise<F[]> {
  const rows: F[] = [];
  for await (const { data } of range) rows.push(data);
  return rows;
}

const titlesIn = async (store: Store, index: Index<{ readonly title: string }>) =>
  (await rowDataOf((await store.scan(index)).orderedBy("title").range([]))).map(({ title }) => title);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an index of rows taken along paths, reading the statements recorded", () => {
  it("holds a row of each statement of the schema, with the value that each path reaches", async () => {
    const [first, second] = [cardOf("b"), cardOf("a")];
    const store = await storeRecording(first, second, lisbon);
    expect(await rowDataOf((await store.scan(ownedCards)).orderedBy("title").range([]))).toEqual([
      { card: new LinkValue(second.link), title: "a", owner: "Ada", city: "Lisbon" },
      { card: new LinkValue(first.link), title: "b", owner: "Ada", city: "Lisbon" },
    ]);
  });

  it("holds no row of a statement of the schema that the store holds and did not record", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const held = cardOf("held");
    await store.write({ roots: [held.link], blobs: [held.bytes, ...closure] });
    expect(await titlesIn(store, ownedCards)).toEqual(["recorded"]);
  });

  it("holds no row of a statement where a link that a path follows leads to an object of another schema", async () => {
    const store = await storeRecording(cardOf("of a person"), cardOf("of a place", lisbon.link));
    expect(await titlesIn(store, ownedCards)).toEqual(["of a person"]);
  });

  it("fails on a statement where a link that a path follows leads to an object that does not fit its schema", async () => {
    const nameless = objectFormat.encode(new ObjectValue(person.link, { home: new LinkValue(lisbon.link) }));
    const store = new Store(new MemoryBackend());
    const statement = cardOf("of no one", linkOf(nameless));
    await store.record({ statements: [statement.link], blobs: [statement.bytes, nameless, ...closure] });
    const { failures } = await store.scan(ownedCards);
    expect(failures.map(({ error }) => String(error))).toEqual([expect.stringContaining("#/name: left out")]);
  });

  it("fails on such a statement whichever path is given first, where another follows a link to another schema", async () => {
    const pair = schema("Pair", { left: link(), right: link() });
    const names = schema("Names", { left: string(), right: string() });
    const memberPair = memberObjectOf(pair);
    const left = memberPair.field("left").objectOf(person).field("name");
    const right = memberPair.field("right").objectOf(person).field("name");
    const nameless = objectFormat.encode(new ObjectValue(person.link, { home: new LinkValue(lisbon.link) }));
    const statement = encodeObject(pair, { left: new LinkValue(lisbon.link), right: new LinkValue(linkOf(nameless)) });
    const store = new Store(new MemoryBackend());
    await store.record({ statements: [statement.link], blobs: [statement.bytes, nameless, ...pair.blobs, ...closure] });
    const leftFirst = indexOfRows(names, { left, right }).reading(recordedStatements);
    const rightFirst = indexOfRows(names, { right, left }).reading(recordedStatements);
    expect(leftFirst.definition).toBeDefined();
    expect(rightFirst.definition?.link).toBe(leftFirst.definition?.link);
    for (const index of [leftFirst, rightFirst]) {
      const { failures } = await store.scan(index);
      expect(failures.map(({ item }) => item)).toEqual([statement.link]);
      expect(failures.map(({ error }) => String(error))).toEqual([expect.stringContaining("#/name: left out")]);
    }
  });

  it.each([
    ["every row holds", string()],
    ["a row may leave out", optional(string())],
  ])("holds the value that a path reaches under a field named __proto__ that %s", async (_, field) => {
    const labeled = schema("Labeled", { ["__proto__"]: field });
    const labels = indexOfRows(labeled, { ["__proto__"]: memberCard.field("title") }).reading(recordedStatements);
    const store = await storeRecording(cardOf("a"), cardOf("b"));
    const rows = await rowDataOf((await store.scan(labels)).orderedBy("__proto__").range(["a"]));
    expect(rows.map((row) => Object.entries(row))).toEqual([[["__proto__", "a"]]]);
  });

  it("reads the statements and what its paths follow, and no other blob held", async () => {
    const backend = new MemoryBackend();
    const requestedLinks: Link<unknown>[] = [];
    const noting: Backend = {
      get: (link) => {
        requestedLinks.push(link);
        return backend.get(link);
      },
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    };
    const store = new Store(noting);
    const [statement, other] = [cardOf("a"), encodeObject(place, { city: "Porto" })];
    await store.record({ statements: [statement.link], blobs: [statement.bytes, ...closure] });
    await store.write({ roots: [other.link], blobs: [other.bytes, ...closure] });
    for await (const _ of store.records());
    requestedLinks.length = 0;
    expect(await titlesIn(store, ownedCards)).toEqual(["a"]);
    expect(new Set(requestedLinks)).toEqual(new Set([statement.link, ada.link, lisbon.link]));
  });

  it("decodes a statement once, to write it and for all the parts of a union that read it", async () => {
    const titleOf = (path: ValuePath<string>) => indexOfRows(titled, { title: path }).reading(recordedStatements);
    const titles = titleOf(memberCard.field("title")).union(
      titleOf(memberObjectOf(place).field("city")),
      titleOf(memberObjectOf(schema("Trip", { name: string() })).field("name")),
    );
    // Written out by hand, so that nothing has decoded them before the store does.
    const people = ["Grace", "Edsger", "Barbara"].map((name) =>
      objectFormat.encode(new ObjectValue(person.link, { name, home: new LinkValue(lisbon.link) })),
    );
    const statements = people.map((bytes) => linkOf(bytes));
    const decode = vi.spyOn(objectFormat, "decode");
    const store = new Store(new MemoryBackend());
    await store.record({ statements, blobs: [...people, ...closure] });
    expect(await titlesIn(store, titles)).toEqual([]);
    const decodedLinks = decode.mock.calls.map(([bytes]) => linkOf(bytes));
    expect(decodedLinks.filter((decoded) => statements.includes(decoded)).sort()).toEqual(statements.sort());
  });

  it("holds the rows of an index that a function gives the rows of as well, in a union with it", async () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [
      { title: data.title.toUpperCase() },
    ]);
    const titles = indexOfRows(titled, { title: memberCard.field("title") }).reading(recordedStatements);
    const store = await storeRecording(cardOf("a"));
    expect(await titlesIn(store, titles.union(shouted))).toEqual(["A", "a"]);
  });
});

describe("an index of rows taken along paths from the Records", () => {
  const record = memberObjectOf(recordSchema);
  const recorded = schema("Recorded", { record: link(), statement: link() });
  const statementsOfRecords = indexOfRows(recorded, { record: record.link, statement: record.field("object") });

  it("holds under the link of a Record the link of the blob that records the statement", async () => {
    const statement = cardOf("a");
    const store = await storeRecording(statement);
    const [row, ...others] = await rowDataOf((await store.scan(statementsOfRecords)).orderedBy("statement").range([]));
    expect(others).toEqual([]);
    expect(row?.statement).toEqual(new LinkValue(statement.link));
    const bytes = await store.get(row?.record.link as Link<unknown>);
    expect(decodeObject(bytes as Uint8Array, recordSchema).data.object).toEqual(new LinkValue(statement.link));
  });
});

describe("an index of rows taken along paths that is given nothing to read", () => {
  const heldTitles = indexOfRows(titled, { title: memberCard.field("title") });

  it("holds a row of each object of the schema among the blobs held, recorded or not", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const [held, deep] = [cardOf("held"), cardOf("deep")];
    const carrying = encodeObject(person, { name: "Bo", home: new LinkValue(deep.link) });
    await store.write({
      roots: [held.link, carrying.link],
      blobs: [held.bytes, carrying.bytes, deep.bytes, ...closure],
    });
    expect(await titlesIn(store, heldTitles)).toEqual(["deep", "held", "recorded"]);
  });
});

describe("an index of rows taken along paths, reading the rows of another index", () => {
  const owners = indexOfRows(titled, { title: memberObjectOf(ownedCard).field("owner") });
  const ownersOfRecordedCards = owners.reading(ownedCards);

  it("holds a row of each row of that index, and none of an object of their schema that the store holds", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const held = encodeObject(ownedCard, { card: new LinkValue(lisbon.link), title: "held", owner: "Bo", city: "" });
    await store.write({ roots: [held.link], blobs: [held.bytes, ...ownedCard.blobs, ...closure] });
    expect(await titlesIn(store, ownersOfRecordedCards)).toEqual(["Ada"]);
    expect(await titlesIn(store, owners)).toEqual(["Bo"]);
  });

  it("holds no row of a blob that what it is given to read gives no item of", async () => {
    const titles = indexOfRows(titled, { title: memberCard.field("title") });
    const shortTitle = new SelectionBySchema(card, (object) => (object.data.title.length < 2 ? object : undefined));
    const store = await storeRecording(cardOf("a"), cardOf("long"));
    expect(await titlesIn(store, titles.reading(selectedRecords(shortTitle)))).toEqual(["a"]);
  });

  it("asks the store for no blob where its paths take what a row holds", async () => {
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
    const statement = cardOf("a");
    await store.record({ statements: [statement.link], blobs: [statement.bytes, ...closure] });
    await store.scan(ownedCards);
    requestedLinks.length = 0;
    expect(await titlesIn(store, ownersOfRecordedCards)).toEqual(["Ada"]);
    expect(requestedLinks).toEqual([]);
  });
});

describe("an index of rows taken along paths from every object held", () => {
  const written = schema("Written", { object: link(), schema: link<Schema>() });
  const schemasOfObjects = indexOfRows(written, { object: anyMemberObject.link, schema: anyMemberObject.schema });
  const linked = schema("Linked", { source: link(), target: link() });
  const image = new TextEncoder().encode("an image");
  const statement = cardOf("a");

  async function storeHoldingAnImage(): Promise<Store> {
    const store = await storeRecording(statement);
    await store.write({ roots: [linkOf(image)], blobs: [image] });
    return store;
  }

  it("holds a row of each object with the schema it is written to, its own link for one written to itself", async () => {
    const rows = (await (await storeHoldingAnImage()).scan(schemasOfObjects)).orderedBy("object");
    const schemaOf = async (object: Link<unknown>) =>
      (await rowDataOf(rows.range([new LinkValue(object)]))).map(({ schema }) => schema.link);
    expect(await schemaOf(statement.link)).toEqual([card.link]);
    expect(await schemaOf(card.link)).toEqual([rootSchema.link]);
    expect(await schemaOf(rootSchema.link)).toEqual([rootSchema.link]);
  });

  it("holds no row of a blob that is not an object", async () => {
    const held = schema("Held", { object: link() });
    const objects = indexOfRows(held, { object: anyMemberObject.link });
    const rows = await (await storeHoldingAnImage()).scan(objects);
    const links = (await rowDataOf(rows)).map(({ object }) => object.link);
    expect(links).toContain(statement.link);
    expect(links).not.toContain(linkOf(image));
    expect(rows.failures).toEqual([]);
  });

  it("holds a row of each link written in an object, that of its schema among them unless it is written to itself", async () => {
    const links = indexOfRows(linked, { source: anyMemberObject.link, target: anyMemberObject.eachLink() });
    const rows = (await (await storeHoldingAnImage()).scan(links)).orderedBy("source", "target");
    const targetsOf = async (source: Link<unknown>) =>
      (await rowDataOf(rows.range([new LinkValue(source)]))).map(({ target }) => target.link);
    expect((await targetsOf(statement.link)).sort()).toEqual([card.link, ada.link].sort());
    expect(await targetsOf(rootSchema.link)).toEqual([]);
  });

  it("decodes an object once, to write it and for its schema and the links it holds", async () => {
    const links = indexOfRows(linked, { source: anyMemberObject.schema, target: anyMemberObject.eachLink() });
    // Written out by hand, so that nothing has decoded it before the store does.
    const braga = objectFormat.encode(new ObjectValue(place.link, { city: "Braga" }));
    const decode = vi.spyOn(objectFormat, "decode");
    const store = await storeHoldingAnImage();
    await store.write({ roots: [linkOf(braga)], blobs: [braga] });
    await store.scan(links);
    expect(decode.mock.calls.filter(([bytes]) => linkOf(bytes) === linkOf(braga))).toHaveLength(1);
  });

  it("holds one value under the fields of a row whose paths expand at the same place", async () => {
    const links = indexOfRows(linked, { source: anyMemberObject.eachLink(), target: anyMemberObject.eachLink() });
    const rows = await rowDataOf(await (await storeHoldingAnImage()).scan(links));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter(({ source, target }) => source.link !== target.link)).toEqual([]);
  });
});

describe("an index of rows taken along paths through the closure of a link", () => {
  const trip = schema("Trip", { name: string(), stops: array(link()) });
  const stop = schema("Stop", { trip: string(), city: string() });
  const memberTrip = memberObjectOf(trip);
  const stops = indexOfRows(stop, {
    trip: memberTrip.field("name"),
    city: memberTrip.link.eachInClosure().objectOf(place).field("city"),
  }).reading(recordedStatements);
  const porto = encodeObject(place, { city: "Porto" });
  const cityless = objectFormat.encode(new ObjectValue(place.link, {}));
  const tripTo = (name: string, ...stopLinks: readonly Link<unknown>[]) =>
    encodeObject(trip, { name, stops: stopLinks.map((stopLink) => new LinkValue(stopLink)) });

  async function storeRecordingTrips(...trips: readonly EncodedObject[]): Promise<Store> {
    const store = new Store(new MemoryBackend());
    await store.record({
      statements: trips.map(({ link }) => link),
      blobs: [...trips.map(({ bytes }) => bytes), porto.bytes, cityless, ...trip.blobs, ...closure],
    });
    return store;
  }

  const stopsIn = async (store: Store) => rowDataOf((await store.scan(stops)).orderedBy("trip", "city").range([]));

  it("holds a row of each object of the schema in the closure, with what the other paths reach", async () => {
    const store = await storeRecordingTrips(tripTo("south", lisbon.link, porto.link, ada.link), tripTo("home"));
    expect(await stopsIn(store)).toEqual([
      { trip: "south", city: "Lisbon" },
      { trip: "south", city: "Porto" },
    ]);
  });

  it("holds no row of a statement where a path that does not expand reaches no value", async () => {
    const home = schema("Home", { owner: string(), city: string() });
    const homes = indexOfRows(home, {
      owner: owner.field("name"),
      city: memberCard.link.eachInClosure().objectOf(place).field("city"),
    }).reading(recordedStatements);
    const store = await storeRecording(cardOf("of a person"), cardOf("of a place", lisbon.link));
    expect(await rowDataOf(await store.scan(homes))).toEqual([{ owner: "Ada", city: "Lisbon" }]);
  });

  it("holds no row of a blob in the closure that names the schema and does not fit it, and the rows of the others", async () => {
    const store = await storeRecordingTrips(tripTo("south", lisbon.link, linkOf(cityless), porto.link));
    expect((await store.scan(stops)).failures).toEqual([]);
    expect(await stopsIn(store)).toEqual([
      { trip: "south", city: "Lisbon" },
      { trip: "south", city: "Porto" },
    ]);
  });

  it.each([
    ["of the closure", stops],
    [
      "that a path follows from a link it expanded to",
      indexOfRows(stop, {
        trip: memberTrip.field("name"),
        city: memberTrip.eachLink().objectOf(place).field("city"),
      }).reading(recordedStatements),
    ],
  ])("is not filled where the store fails to give a blob %s", async (_, index) => {
    const backend = new MemoryBackend();
    const diskError = new Error("the disk is gone");
    let isFailing = false;
    const store = new Store({
      get: (link) => (isFailing && link === porto.link ? Promise.reject(diskError) : backend.get(link)),
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    });
    const south = tripTo("south", lisbon.link, porto.link);
    await store.record({ statements: [south.link], blobs: [south.bytes, porto.bytes, ...trip.blobs, ...closure] });
    // The Records are listed while every blob can be read, so the scan fails where the paths read.
    for await (const _ of store.records());
    isFailing = true;
    await expect(store.scan(index)).rejects.toBe(diskError);
    isFailing = false;
    expect(await rowDataOf((await store.scan(index)).orderedBy("trip", "city").range([]))).toEqual([
      { trip: "south", city: "Lisbon" },
      { trip: "south", city: "Porto" },
    ]);
  });
});

describe("a union of indexes", () => {
  const aliased = schema("Aliased", { title: string(), alias: optional(string()) });
  const title = memberCard.field("title");
  const refusal = "the indexes in a union hold rows of one schema, and one of these holds rows of another";

  it("is refused where they hold rows of two schemas, whichever comes first", () => {
    const [titles, aliases] = [indexOfRows(titled, { title }), indexOfRows(aliased, { title, alias: title })];
    expect(() => titles.union(aliases)).toThrow(refusal);
    expect(() => aliases.union(titles)).toThrow(refusal);
  });

  it("is refused where a function gives the rows of one of another schema", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), aliased, ({ data }) => [{ title: data.title }]);
    expect(() => indexOfRows(titled, { title }).union(shouted)).toThrow(refusal);
  });
});

describe("the definition of an index", () => {
  const linkTo = ({ link }: Schema) => new LinkValue(link);

  it("holds the schema of the rows and the steps of each part", () => {
    const titles = indexOfRows(titled, { title: memberCard.field("title") });
    const { definition } = ownedCards.union(ownedCards);
    const as = (taken: Schema) => ({ step: "as", schema: linkTo(taken) });
    const follow = (name: string, followed: Schema) => [{ step: "field", name }, { step: "object" }, as(followed)];
    const toCard = [as(card)];
    const toOwner = [...toCard, ...follow("owner", person)];
    const part = {
      paths: {
        card: [...toCard, { step: "link" }],
        title: [...toCard, { step: "field", name: "title" }],
        owner: [...toOwner, { step: "field", name: "name" }],
        city: [...toOwner, ...follow("home", place), { step: "field", name: "city" }],
      },
    };
    expect(definition?.data).toEqual({ rows: linkTo(ownedCard), parts: [part, part] });
    expect(titles.definition?.data.parts).toEqual([{ paths: { title: [as(card), { step: "field", name: "title" }] } }]);
  });

  it("holds no step that takes the object read as a schema where the paths say none, and the steps that expand", () => {
    const linked = schema("Linked", { source: link(), target: link() });
    const links = indexOfRows(linked, { source: anyMemberObject.link, target: anyMemberObject.eachLink() });
    const closures = indexOfRows(linked, {
      source: anyMemberObject.link,
      target: anyMemberObject.link.eachInClosure().objectOf(card).field("owner"),
    });
    expect(links.definition?.data.parts).toEqual([
      { paths: { source: [{ step: "link" }], target: [{ step: "eachLink" }] } },
    ]);
    expect(closures.definition?.data.parts).toEqual([
      {
        paths: {
          source: [{ step: "link" }],
          target: [
            { step: "link" },
            { step: "eachInClosure" },
            { step: "object" },
            { step: "as", schema: linkTo(card) },
            { step: "field", name: "owner" },
          ],
        },
      },
    ]);
    const written = schema("Written", { object: link(), schema: link<Schema>() });
    const schemasOfObjects = indexOfRows(written, { object: anyMemberObject.link, schema: anyMemberObject.schema });
    expect(schemasOfObjects.definition?.data.parts).toEqual([
      { paths: { object: [{ step: "link" }], schema: [{ step: "schema" }] } },
    ]);
  });

  it("has the same link for the same rows and parts, and another for other parts or rows of another schema", () => {
    const again = indexOfRows(ownedCard, {
      city: memberObjectOf(card).field("owner").objectOf(person).field("home").objectOf(place).field("city"),
      owner: memberObjectOf(card).field("owner").objectOf(person).field("name"),
      title: memberObjectOf(card).field("title"),
      card: memberObjectOf(card).link,
    });
    const definitionLinkOf = ({ definition }: { readonly definition: IndexDefinition | undefined }) => {
      assert.exists(definition);
      return definition.link;
    };
    expect(definitionLinkOf(again)).toBe(definitionLinkOf(ownedCards));
    expect(definitionLinkOf(ownedCards.union(ownedCards))).not.toBe(definitionLinkOf(ownedCards));
    const title = memberCard.field("title");
    const retitled = schema("Retitled", { title: string() });
    expect(definitionLinkOf(indexOfRows(retitled, { title }))).not.toBe(
      definitionLinkOf(indexOfRows(titled, { title })),
    );
  });

  it("has the same link whatever the index is given to read", () => {
    expect(ownedCardsOfAll.definition).toBeDefined();
    expect(ownedCards.definition?.link).toBe(ownedCardsOfAll.definition?.link);
    expect(ownedCardsOfAll.reading(ownedCards).definition?.link).toBe(ownedCardsOfAll.definition?.link);
  });

  it("is absent where a function gives the rows of a part", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [{ title: data.title }]);
    const titles = indexOfRows(titled, { title: memberCard.field("title") });
    expect(titles.union(shouted).definition).toBeUndefined();
    expect(shouted.definition).toBeUndefined();
  });
});

describe("an index of rows taken along paths", () => {
  const untyped: Schema = titled;
  const title = memberCard.field("title");

  it("is refused where a field of the rows has no path, or a path is for no field of the rows", () => {
    expect(() => indexOfRows(untyped, { name: title })).toThrow("no path is given for the field title of Titled");
    expect(() => indexOfRows(untyped, { title, name: title })).toThrow(
      "a path is given for name, which Titled has not",
    );
  });

  it("is refused where a path takes a field that the schema has not, or that an object may leave out", () => {
    const untypedPerson: Schema = person;
    expect(() => indexOfRows(untyped, { title: memberObjectOf(untypedPerson).field("title") })).toThrow(
      "the path of title in Titled takes the field title, which Person has not",
    );
    expect(() => indexOfRows(untyped, { title: memberObjectOf(untypedPerson).field("nickname") })).toThrow(
      "the path of title in Titled takes the field nickname, which an object of Person may leave out",
    );
  });

  it("is refused where a path gives another type than the field of the rows takes", () => {
    expect(() => indexOfRows(untyped, { title: memberCard.field("tags") })).toThrow(
      "the path of title in Titled gives array of string, and the row takes string",
    );
    expect(() => indexOfRows(untyped, { title: memberCard.link })).toThrow(
      "the path of title in Titled gives link, and the row takes string",
    );
  });

  it("is refused where its paths take one object as two schemas", () => {
    const pair = schema("Pair", { title: string(), name: string() });
    expect(() => indexOfRows(pair, { title, name: memberObjectOf(person).field("name") })).toThrow(
      "the path of name in Pair takes as Person an object that another path takes as Card",
    );
    const followed = memberCard.field("owner");
    const [name, city] = [followed.objectOf(person).field("name"), followed.objectOf(place).field("city")];
    expect(() => indexOfRows(pair, { title: city, name })).toThrow(
      "the path of name in Pair takes as Person an object that another path takes as Place",
    );
  });

  it("is refused where its paths expand at two places", () => {
    const pair = schema("Pair", { left: link(), right: link() });
    const refusal = "the path of right in Pair expands at a second place, and a part expands at one";
    const closure = anyMemberObject.link.eachInClosure();
    expect(() => indexOfRows(pair, { left: anyMemberObject.eachLink(), right: closure })).toThrow(refusal);
    expect(() => indexOfRows(pair, { left: closure, right: closure.eachInClosure() })).toThrow(refusal);
  });

  it("takes the paths that the compiler finds to fit the rows and the schemas they pass", () => {
    const counted = schema("Counted", { count: integer() });
    // @ts-expect-error A string is not the integer that the field of the rows takes.
    const count: ValuePath<number> = title;
    expect(() => indexOfRows(counted, { count })).toThrow("gives string, and the row takes integer");
    // @ts-expect-error A field that an object may leave out is not one that a path takes.
    const nickname: ValuePath<string> = memberObjectOf(person).field("nickname");
    expect(() => indexOfRows(titled, { title: nickname })).toThrow("may leave out");
    // @ts-expect-error A string leads to no object.
    const followed = title.objectOf(card);
    expect(() => indexOfRows(titled, { title: followed.field("title") })).toThrow(
      "follows string, and only a link leads to an object",
    );
    // @ts-expect-error A path that does not say the schema of an object takes no field of it.
    const unsaid: ValuePath<string> = anyMemberObject.field("title");
    expect(() => indexOfRows(titled, { title: unsaid })).toThrow(
      "takes the field title of an object whose schema it does not say",
    );
    const linked = schema("Linked", { title: link() });
    // @ts-expect-error A string has no closure.
    const expanded = title.eachInClosure();
    expect(() => indexOfRows(linked, { title: expanded })).toThrow(
      "expands the closure of string, which is taken of a link",
    );
  });
});
