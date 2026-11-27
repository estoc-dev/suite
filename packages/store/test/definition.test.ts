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
  heldBlobs,
  type Index,
  type IndexDefinition,
  indexOver,
  linkedBlob,
  MemoryBackend,
  memberObjectOf,
  recordedStatements,
  recordSchema,
  type Source,
  Store,
  selectedRecords,
  type ValuePath,
} from "../src/index.ts";

const place = schema("Place", { city: string() });
const person = schema("Person", { name: string(), home: link(), nickname: optional(string()) });
const card = schema("Card", { title: string(), owner: link(), tags: array(string()) });
const schemas = [place, person, card].flatMap(({ blobs }) => blobs);

const cardRow = schema("Card Row", { card: link(), title: string(), owner: link() });
const titled = schema("Titled", { title: string() });

const memberCard = memberObjectOf(card);
const cardPaths = { card: memberCard.link, title: memberCard.field("title"), owner: memberCard.field("owner") };
const cardRows = recordedStatements.rowsTaking(cardRow, cardPaths);

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
  it("holds a row of each statement of the schema, with what each path takes of it", async () => {
    const [first, second] = [cardOf("b"), cardOf("a")];
    const store = await storeRecording(first, second, lisbon);
    expect(await rowDataOf((await store.scan(cardRows)).orderedBy("title").range([]))).toEqual([
      { card: new LinkValue(second.link), title: "a", owner: new LinkValue(ada.link) },
      { card: new LinkValue(first.link), title: "b", owner: new LinkValue(ada.link) },
    ]);
  });

  it("holds no row of a statement of the schema that the store holds and did not record", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const held = cardOf("held");
    await store.write({ roots: [held.link], blobs: [held.bytes, ...closure] });
    expect(await titlesIn(store, cardRows)).toEqual(["recorded"]);
  });

  it.each([
    ["every row holds", string()],
    ["a row may leave out", optional(string())],
  ])("holds the value that a path reaches under a field named __proto__ that %s", async (_, field) => {
    const labeled = schema("Labeled", { ["__proto__"]: field });
    const labels = recordedStatements.rowsTaking(labeled, { ["__proto__"]: memberCard.field("title") });
    const store = await storeRecording(cardOf("a"), cardOf("b"));
    const rows = await rowDataOf((await store.scan(labels)).orderedBy("__proto__").range(["a"]));
    expect(rows.map((row) => Object.entries(row))).toEqual([[["__proto__", "a"]]]);
  });

  it("reads the statements, and no other blob held", async () => {
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
    expect(await titlesIn(store, cardRows)).toEqual(["a"]);
    expect(new Set(requestedLinks)).toEqual(new Set([statement.link]));
  });

  it("decodes a statement once, to write it and for all the parts of a union that read it", async () => {
    const titleOf = (path: ValuePath<string>) => recordedStatements.rowsTaking(titled, { title: path });
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
    const titles = recordedStatements.rowsTaking(titled, { title: memberCard.field("title") });
    const store = await storeRecording(cardOf("a"));
    expect(await titlesIn(store, titles.union(shouted))).toEqual(["A", "a"]);
  });
});

describe("an index of rows taken along paths from the Records", () => {
  const record = memberObjectOf(recordSchema);
  const recorded = schema("Recorded", { record: link(), statement: link() });
  const statementsOfRecords = heldBlobs.rowsTaking(recorded, {
    record: record.link,
    statement: record.field("object"),
  });

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

describe("an index of rows taken along paths, reading every blob held", () => {
  const heldTitles = heldBlobs.rowsTaking(titled, { title: memberCard.field("title") });

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

  it("fails on an object that names the schema and does not fit it, and holds the rows of the others", async () => {
    const untitled = objectFormat.encode(new ObjectValue(card.link, { owner: new LinkValue(ada.link), tags: [] }));
    const store = await storeRecording(cardOf("a"));
    await store.write({ roots: [linkOf(untitled)], blobs: [untitled] });
    const { failures } = await store.scan(heldTitles);
    expect(await titlesIn(store, heldTitles)).toEqual(["a"]);
    expect(failures.map(({ item }) => item)).toEqual([linkOf(untitled)]);
    expect(failures.map(({ error }) => String(error))).toEqual([expect.stringContaining("#/title: left out")]);
  });

  it("holds no row where its paths take an object as two schemas, and fails on one that names either and does not fit it, whichever path is given first", async () => {
    const names = schema("Names", { name: string(), city: string() });
    const [name, city] = [memberObjectOf(person).field("name"), memberObjectOf(place).field("city")];
    const nameless = objectFormat.encode(new ObjectValue(person.link, { home: new LinkValue(lisbon.link) }));
    const store = await storeRecording(cardOf("a"));
    await store.write({ roots: [linkOf(nameless)], blobs: [nameless] });
    for (const index of [heldBlobs.rowsTaking(names, { name, city }), heldBlobs.rowsTaking(names, { city, name })]) {
      const rows = await store.scan(index);
      expect(await rowDataOf(rows)).toEqual([]);
      expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(nameless)]);
    }
  });
});

describe("an index of rows taken along paths, reading the rows of another index", () => {
  const rowTitle = { title: memberObjectOf(cardRow).field("title") };
  const titlesOfRecordedCards = cardRows.rowsTaking(titled, rowTitle);

  it("holds a row of each row of that index, and none of an object of their schema that the store holds", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const [card, owner] = [new LinkValue(lisbon.link), new LinkValue(ada.link)];
    const held = encodeObject(cardRow, { card, title: "held", owner });
    await store.write({ roots: [held.link], blobs: [held.bytes, ...cardRow.blobs, ...closure] });
    expect(await titlesIn(store, titlesOfRecordedCards)).toEqual(["recorded"]);
    expect(await titlesIn(store, heldBlobs.rowsTaking(titled, rowTitle))).toEqual(["held"]);
  });

  it("takes the link of a row, which the store does not hold, and is joined at it to what the row holds", async () => {
    const pointers = cardRows.rowsTaking(schema("Pointer", { row: link() }), { row: anyMemberObject.link });
    const store = await storeRecording(cardOf("recorded"));
    const [pointer] = await rowDataOf(await store.scan(pointers));
    assert(pointer !== undefined);
    expect(await store.get(pointer.row.link)).toBeUndefined();
    expect(
      await rowDataOf(await store.scan(pointers.rowsJoinedAt("row", linkedBlob.rowsTaking(titled, rowTitle)))),
    ).toEqual([{ row: pointer.row, title: "recorded" }]);
  });

  it("holds no row of a blob that what it reads gives no item of", async () => {
    const shortTitle = new SelectionBySchema(card, (object) => (object.data.title.length < 2 ? object : undefined));
    const store = await storeRecording(cardOf("a"), cardOf("long"));
    const titles = selectedRecords(shortTitle).rowsTaking(titled, { title: memberCard.field("title") });
    expect(await titlesIn(store, titles)).toEqual(["a"]);
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
    await store.scan(cardRows);
    requestedLinks.length = 0;
    expect(await titlesIn(store, titlesOfRecordedCards)).toEqual(["a"]);
    expect(requestedLinks).toEqual([]);
  });
});

describe("an index of rows taken along paths from every object held", () => {
  const written = schema("Written", { object: link(), schema: link<Schema>() });
  const schemasOfObjects = heldBlobs.rowsTaking(written, {
    object: anyMemberObject.link,
    schema: anyMemberObject.schema,
  });
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
    const objects = heldBlobs.rowsTaking(held, { object: anyMemberObject.link });
    const rows = await (await storeHoldingAnImage()).scan(objects);
    const links = (await rowDataOf(rows)).map(({ object }) => object.link);
    expect(links).toContain(statement.link);
    expect(links).not.toContain(linkOf(image));
    expect(rows.failures).toEqual([]);
  });

  it("decodes an object once, to write it and for its link and its schema", async () => {
    // Written out by hand, so that nothing has decoded it before the store does.
    const braga = objectFormat.encode(new ObjectValue(place.link, { city: "Braga" }));
    const decode = vi.spyOn(objectFormat, "decode");
    const store = await storeHoldingAnImage();
    await store.write({ roots: [linkOf(braga)], blobs: [braga] });
    await store.scan(schemasOfObjects);
    expect(decode.mock.calls.filter(([bytes]) => linkOf(bytes) === linkOf(braga))).toHaveLength(1);
  });
});

describe("a union of indexes", () => {
  const aliased = schema("Aliased", { title: string(), alias: optional(string()) });
  const title = memberCard.field("title");
  const refusal = "the indexes in a union hold rows of one schema, and one of these holds rows of another";

  it("is refused where they hold rows of two schemas, whichever comes first", () => {
    const [titles, aliases] = [
      heldBlobs.rowsTaking(titled, { title }),
      heldBlobs.rowsTaking(aliased, { title, alias: title }),
    ];
    expect(() => titles.union(aliases)).toThrow(refusal);
    expect(() => aliases.union(titles)).toThrow(refusal);
  });

  it("is refused where a function gives the rows of one of another schema", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), aliased, ({ data }) => [{ title: data.title }]);
    expect(() => heldBlobs.rowsTaking(titled, { title }).union(shouted)).toThrow(refusal);
  });
});

describe("the definition of an index", () => {
  const linkTo = ({ link }: Schema) => new LinkValue(link);

  it("holds the schema of the rows and the paths of each part", () => {
    const titles = heldBlobs.rowsTaking(titled, { title: memberCard.field("title") });
    const { definition } = cardRows.union(cardRows);
    const memberSchema = linkTo(card);
    const title = { take: "field", name: "title", memberSchema };
    const part = {
      paths: { card: { take: "link", memberSchema }, title, owner: { take: "field", name: "owner", memberSchema } },
    };
    expect(definition?.data).toEqual({ rows: linkTo(cardRow), parts: [part, part] });
    expect(titles.definition?.data.parts).toEqual([{ paths: { title } }]);
  });

  it("holds no schema in a path that says none of the object read", () => {
    const written = schema("Written", { object: link(), schema: link<Schema>() });
    const schemasOfObjects = heldBlobs.rowsTaking(written, {
      object: anyMemberObject.link,
      schema: anyMemberObject.schema,
    });
    expect(schemasOfObjects.definition?.data.parts).toEqual([
      { paths: { object: { take: "link" }, schema: { take: "schema" } } },
    ]);
  });

  it("has the same link for the same rows and parts, and another for other parts or rows of another schema", () => {
    const again = heldBlobs.rowsTaking(cardRow, {
      owner: memberObjectOf(card).field("owner"),
      title: memberObjectOf(card).field("title"),
      card: memberObjectOf(card).link,
    });
    const definitionLinkOf = ({ definition }: { readonly definition: IndexDefinition | undefined }) => {
      assert.exists(definition);
      return definition.link;
    };
    expect(definitionLinkOf(again)).toBe(definitionLinkOf(cardRows));
    expect(definitionLinkOf(cardRows.union(cardRows))).not.toBe(definitionLinkOf(cardRows));
    const title = memberCard.field("title");
    const retitled = schema("Retitled", { title: string() });
    expect(definitionLinkOf(heldBlobs.rowsTaking(retitled, { title }))).not.toBe(
      definitionLinkOf(heldBlobs.rowsTaking(titled, { title })),
    );
  });

  it("has the same link whatever the index reads", () => {
    const definitionLinkReading = (source: Source<unknown>) => source.rowsTaking(cardRow, cardPaths).definition?.link;
    expect(cardRows.definition).toBeDefined();
    for (const source of [heldBlobs, linkedBlob, cardRows])
      expect(definitionLinkReading(source)).toBe(cardRows.definition?.link);
  });

  it("holds the parts of a union in the order they were given in, whatever each of them reads", () => {
    const statementsAgain = heldBlobs
      .rowsTaking(recordSchema, {
        object: memberObjectOf(recordSchema).field("object"),
      })
      .linksAt("object");
    const paths = [
      memberCard.field("title"),
      memberObjectOf(person).field("name"),
      memberObjectOf(place).field("city"),
    ];
    const namesReading = (source: Source<unknown>) => {
      const [titles, names, cities] = [recordedStatements, source, recordedStatements].map((read, at) =>
        read.rowsTaking(titled, { title: paths[at] as ValuePath<string> }),
      );
      assert(titles !== undefined && names !== undefined && cities !== undefined);
      return titles.union(names, cities);
    };
    const { definition } = namesReading(statementsAgain);
    expect(definition?.data.parts).toEqual(
      paths.flatMap((title) => heldBlobs.rowsTaking(titled, { title }).definition?.data.parts),
    );
    expect(definition?.link).toBe(namesReading(recordedStatements).definition?.link);
  });

  it("is absent where a function gives the rows of a part", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [{ title: data.title }]);
    const titles = heldBlobs.rowsTaking(titled, { title: memberCard.field("title") });
    expect(titles.union(shouted).definition).toBeUndefined();
    expect(shouted.definition).toBeUndefined();
  });
});

describe("an index of rows taken along paths", () => {
  const untyped: Schema = titled;
  const title = memberCard.field("title");

  it("is refused where a field of the rows has no path, or a path is for no field of the rows", () => {
    expect(() => heldBlobs.rowsTaking(untyped, { name: title })).toThrow(
      "no path is given for the field title of Titled",
    );
    expect(() => heldBlobs.rowsTaking(untyped, { title, name: title })).toThrow(
      "a path is given for name, which Titled has not",
    );
  });

  it("is refused where a path takes a field that the schema has not, or that an object may leave out", () => {
    const untypedPerson: Schema = person;
    expect(() => heldBlobs.rowsTaking(untyped, { title: memberObjectOf(untypedPerson).field("title") })).toThrow(
      "the path of title in Titled takes the field title, which Person has not",
    );
    expect(() => heldBlobs.rowsTaking(untyped, { title: memberObjectOf(untypedPerson).field("nickname") })).toThrow(
      "the path of title in Titled takes the field nickname, which an object of Person may leave out",
    );
  });

  it("is refused where a path gives another type than the field of the rows takes", () => {
    expect(() => heldBlobs.rowsTaking(untyped, { title: memberCard.field("tags") })).toThrow(
      "the path of title in Titled gives array of string, and the row takes string",
    );
    expect(() => heldBlobs.rowsTaking(untyped, { title: memberCard.link })).toThrow(
      "the path of title in Titled gives link, and the row takes string",
    );
  });

  it("takes the paths that the compiler finds to fit the rows and the schema they take the object as", () => {
    const counted = schema("Counted", { count: integer() });
    // @ts-expect-error A string is not the integer that the field of the rows takes.
    const count: ValuePath<number> = title;
    expect(() => heldBlobs.rowsTaking(counted, { count })).toThrow("gives string, and the row takes integer");
    // @ts-expect-error A field that an object may leave out is not one that a path takes.
    const nickname: ValuePath<string> = memberObjectOf(person).field("nickname");
    expect(() => heldBlobs.rowsTaking(titled, { title: nickname })).toThrow("may leave out");
    // @ts-expect-error A path that does not say the schema of an object takes no field of it.
    expect(() => anyMemberObject.field("title")).toThrow(
      "a path takes the field title of an object whose schema it does not say",
    );
  });
});
