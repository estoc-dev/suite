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
  type Schema,
} from "@estoc/object";
import { array, integer, link, optional, schema, string } from "@estoc/schema";
import { assert, describe, expect, it } from "vitest";
import {
  type Backend,
  type FieldNames,
  heldObject,
  type IndexDefinition,
  indexOfRows,
  indexOver,
  MemoryBackend,
  type OrderedIndex,
  recordedStatement,
  recordSchema,
  Store,
  selectedRecords,
  type ValuePath,
} from "../src/index.ts";
import { recordOf } from "../src/record.ts";

const place = schema("Place", { city: string() });
const person = schema("Person", { name: string(), home: link(), nickname: optional(string()) });
const card = schema("Card", { title: string(), owner: link(), tags: array(string()) });
const schemas = [place, person, card].flatMap(({ blobs }) => blobs);

const ownedCard = schema("Owned Card", { card: link(), title: string(), owner: string(), city: string() });
const titled = schema("Titled", { title: string() });

const recordedCard = recordedStatement(card);
const owner = recordedCard.field("owner").objectOf(person);
const ownedCards = indexOfRows(ownedCard, {
  card: recordedCard.link,
  title: recordedCard.field("title"),
  owner: owner.field("name"),
  city: owner.field("home").objectOf(place).field("city"),
});
const byTitle = ownedCards.orderedBy("title");

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

const titlesIn = async <F extends { readonly title: string }>(store: Store, index: OrderedIndex<F, FieldNames<F>>) =>
  (await rowDataOf((await store.scan(index)).range([]))).map(({ title }) => title);

describe("an index of rows taken along paths from the statements recorded", () => {
  it("holds a row of each statement of the schema, with the value that each path reaches", async () => {
    const [first, second] = [cardOf("b"), cardOf("a")];
    const store = await storeRecording(first, second, lisbon);
    expect(await rowDataOf((await store.scan(byTitle)).range([]))).toEqual([
      { card: new LinkValue(second.link), title: "a", owner: "Ada", city: "Lisbon" },
      { card: new LinkValue(first.link), title: "b", owner: "Ada", city: "Lisbon" },
    ]);
  });

  it("holds no row of a statement of the schema that the store holds and did not record", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const held = cardOf("held");
    await store.write({ roots: [held.link], blobs: [held.bytes, ...closure] });
    expect(await titlesIn(store, byTitle)).toEqual(["recorded"]);
  });

  it("holds no row of a statement where a link that a path follows leads to an object of another schema", async () => {
    const store = await storeRecording(cardOf("of a person"), cardOf("of a place", lisbon.link));
    expect(await titlesIn(store, byTitle)).toEqual(["of a person"]);
  });

  it("fails on a statement where a link that a path follows leads to an object that does not fit its schema", async () => {
    const nameless = objectFormat.encode(new ObjectValue(person.link, { home: new LinkValue(lisbon.link) }));
    const store = new Store(new MemoryBackend());
    const statement = cardOf("of no one", linkOf(nameless));
    await store.record({ statements: [statement.link], blobs: [statement.bytes, nameless, ...closure] });
    const { failures } = await store.scan(byTitle);
    expect(failures.map(({ error }) => String(error))).toEqual([expect.stringContaining("#/name: left out")]);
  });

  it("fails on such a statement whichever path is given first, where another follows a link to another schema", async () => {
    const pair = schema("Pair", { left: link(), right: link() });
    const names = schema("Names", { left: string(), right: string() });
    const recordedPair = recordedStatement(pair);
    const left = recordedPair.field("left").objectOf(person).field("name");
    const right = recordedPair.field("right").objectOf(person).field("name");
    const nameless = objectFormat.encode(new ObjectValue(person.link, { home: new LinkValue(lisbon.link) }));
    const statement = encodeObject(pair, { left: new LinkValue(lisbon.link), right: new LinkValue(linkOf(nameless)) });
    const store = new Store(new MemoryBackend());
    await store.record({ statements: [statement.link], blobs: [statement.bytes, nameless, ...pair.blobs, ...closure] });
    const leftFirst = indexOfRows(names, { left, right });
    const rightFirst = indexOfRows(names, { right, left });
    expect(leftFirst.definition).toBeDefined();
    expect(rightFirst.definition?.link).toBe(leftFirst.definition?.link);
    for (const index of [leftFirst, rightFirst]) {
      const { failures } = await store.scan(index.orderedBy("left"));
      expect(failures.map(({ item }) => item)).toEqual([recordOf(statement.link).link]);
      expect(failures.map(({ error }) => String(error))).toEqual([expect.stringContaining("#/name: left out")]);
    }
  });

  it.each([
    ["every row holds", string()],
    ["a row may leave out", optional(string())],
  ])("holds the value that a path reaches under a field named __proto__ that %s", async (_, field) => {
    const labeled = schema("Labeled", { ["__proto__"]: field });
    const byLabel = indexOfRows(labeled, { ["__proto__"]: recordedCard.field("title") }).orderedBy("__proto__");
    const store = await storeRecording(cardOf("a"), cardOf("b"));
    const rows = await rowDataOf((await store.scan(byLabel)).range(["a"]));
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
    expect(await titlesIn(store, byTitle)).toEqual(["a"]);
    expect(new Set(requestedLinks)).toEqual(new Set([statement.link, ada.link, lisbon.link]));
  });

  it("holds the rows of an index that a function gives the rows of as well, in a union with it", async () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [
      { title: data.title.toUpperCase() },
    ]);
    const titles = indexOfRows(titled, { title: recordedCard.field("title") });
    const store = await storeRecording(cardOf("a"));
    expect(await titlesIn(store, titles.union(shouted).orderedBy("title"))).toEqual(["A", "a"]);
  });
});

describe("an index of rows taken along paths from the Records", () => {
  const record = heldObject(recordSchema);
  const recorded = schema("Recorded", { record: link(), statement: link() });
  const byStatement = indexOfRows(recorded, { record: record.link, statement: record.field("object") }).orderedBy(
    "statement",
  );

  it("holds under the link of a Record the link of the blob that records the statement", async () => {
    const statement = cardOf("a");
    const store = await storeRecording(statement);
    const [row, ...others] = await rowDataOf((await store.scan(byStatement)).range([]));
    expect(others).toEqual([]);
    expect(row?.statement).toEqual(new LinkValue(statement.link));
    const bytes = await store.get(row?.record.link as Link<unknown>);
    expect(decodeObject(bytes as Uint8Array, recordSchema).data.object).toEqual(new LinkValue(statement.link));
  });
});

describe("an index of rows taken along paths from the objects held of a schema", () => {
  const heldCard = heldObject(card);
  const byHeldTitle = indexOfRows(titled, { title: heldCard.field("title") }).orderedBy("title");

  it("holds a row of each object of the schema, recorded or not", async () => {
    const store = await storeRecording(cardOf("recorded"));
    const [held, deep] = [cardOf("held"), cardOf("deep")];
    const carrying = encodeObject(person, { name: "Bo", home: new LinkValue(deep.link) });
    await store.write({
      roots: [held.link, carrying.link],
      blobs: [held.bytes, carrying.bytes, deep.bytes, ...closure],
    });
    expect(await titlesIn(store, byHeldTitle)).toEqual(["deep", "held", "recorded"]);
  });
});

describe("a union of indexes", () => {
  const aliased = schema("Aliased", { title: string(), alias: optional(string()) });
  const title = recordedCard.field("title");
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

  it("holds the schema of the rows and what each part reads and takes", () => {
    const titles = indexOfRows(titled, { title: heldObject(card).field("title") });
    const { definition } = ownedCards.union(ownedCards);
    const follow = (name: string, followed: Schema) => [
      { step: "field", name },
      { step: "object", schema: linkTo(followed) },
    ];
    const toCard = follow("object", card);
    const toOwner = [...toCard, ...follow("owner", person)];
    const part = {
      schema: linkTo(recordSchema),
      paths: {
        card: [...toCard, { step: "link" }],
        title: [...toCard, { step: "field", name: "title" }],
        owner: [...toOwner, { step: "field", name: "name" }],
        city: [...toOwner, ...follow("home", place), { step: "field", name: "city" }],
      },
    };
    expect(definition?.data).toEqual({ rows: linkTo(ownedCard), parts: [part, part] });
    expect(titles.definition?.data.parts).toEqual([
      { schema: linkTo(card), paths: { title: [{ step: "field", name: "title" }] } },
    ]);
  });

  it("has the same link for the same rows and parts, and another for other parts or rows of another schema", () => {
    const again = indexOfRows(ownedCard, {
      city: recordedStatement(card).field("owner").objectOf(person).field("home").objectOf(place).field("city"),
      owner: recordedStatement(card).field("owner").objectOf(person).field("name"),
      title: recordedStatement(card).field("title"),
      card: recordedStatement(card).link,
    });
    const definitionLinkOf = ({ definition }: { readonly definition: IndexDefinition | undefined }) => {
      assert.exists(definition);
      return definition.link;
    };
    expect(definitionLinkOf(again)).toBe(definitionLinkOf(ownedCards));
    expect(definitionLinkOf(ownedCards.union(ownedCards))).not.toBe(definitionLinkOf(ownedCards));
    const title = heldObject(card).field("title");
    const retitled = schema("Retitled", { title: string() });
    expect(definitionLinkOf(indexOfRows(retitled, { title }))).not.toBe(
      definitionLinkOf(indexOfRows(titled, { title })),
    );
  });

  it("is absent where a function gives the rows of a part", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [{ title: data.title }]);
    const titles = indexOfRows(titled, { title: recordedCard.field("title") });
    expect(titles.union(shouted).definition).toBeUndefined();
    expect(shouted.definition).toBeUndefined();
  });
});

describe("an index of rows taken along paths", () => {
  const untyped: Schema = titled;
  const title = recordedCard.field("title");

  it("is refused where a field of the rows has no path, or a path is for no field of the rows", () => {
    expect(() => indexOfRows(untyped, { name: title })).toThrow("no path is given for the field title of Titled");
    expect(() => indexOfRows(untyped, { title, name: title })).toThrow(
      "a path is given for name, which Titled has not",
    );
  });

  it("is refused where a path takes a field that the schema has not, or that an object may leave out", () => {
    const untypedPerson: Schema = person;
    expect(() => indexOfRows(untyped, { title: recordedStatement(untypedPerson).field("title") })).toThrow(
      "the path of title in Titled takes the field title, which Person has not",
    );
    expect(() => indexOfRows(untyped, { title: recordedStatement(untypedPerson).field("nickname") })).toThrow(
      "the path of title in Titled takes the field nickname, which an object of Person may leave out",
    );
  });

  it("is refused where a path gives another type than the field of the rows takes", () => {
    expect(() => indexOfRows(untyped, { title: recordedCard.field("tags") })).toThrow(
      "the path of title in Titled gives array of string, and the row takes string",
    );
    expect(() => indexOfRows(untyped, { title: recordedCard.link })).toThrow(
      "the path of title in Titled gives link, and the row takes string",
    );
  });

  it("is refused where its paths start at objects of two schemas", () => {
    const pair = schema("Pair", { title: string(), name: string() });
    expect(() => indexOfRows(pair, { title, name: heldObject(person).field("name") })).toThrow(
      "the paths of a part start at one schema, and that of name at another",
    );
  });

  it("takes the paths that the compiler finds to fit the rows and the schemas they pass", () => {
    const counted = schema("Counted", { count: integer() });
    // @ts-expect-error A string is not the integer that the field of the rows takes.
    const count: ValuePath<number> = title;
    expect(() => indexOfRows(counted, { count })).toThrow("gives string, and the row takes integer");
    // @ts-expect-error A field that an object may leave out is not one that a path takes.
    const nickname: ValuePath<string> = recordedStatement(person).field("nickname");
    expect(() => indexOfRows(titled, { title: nickname })).toThrow("may leave out");
    // @ts-expect-error A string leads to no object.
    const followed = title.objectOf(card);
    expect(() => indexOfRows(titled, { title: followed.field("title") })).toThrow(
      "follows string, and only a link leads to an object",
    );
  });
});
