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
import { describe, expect, it } from "vitest";
import {
  type Backend,
  type FieldNames,
  heldObject,
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
    expect(byTitle.readsBlobs).toBe(false);
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
    await expect(store.scan(byTitle)).rejects.toThrow("#/name: left out");
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
    expect(byHeldTitle.readsBlobs).toBe(true);
  });
});

describe("the definition of a named index", () => {
  const linkTo = ({ link }: Schema) => new LinkValue(link);

  it("holds the name, the schema of the rows, the order and what each part reads and takes", () => {
    const titles = indexOfRows(titled, { title: heldObject(card).field("title") });
    const { definition } = ownedCards.union(ownedCards).orderedBy("title", "card").named("Owned Cards");
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
    expect(definition?.data).toEqual({
      title: "Owned Cards",
      rows: linkTo(ownedCard),
      order: ["title", "card"],
      parts: [part, part],
    });
    expect(titles.orderedBy("title").named("Titles").definition?.data.parts).toEqual([
      { schema: linkTo(card), paths: { title: [{ step: "field", name: "title" }] } },
    ]);
  });

  it("has the same link for the same name, rows, order and parts, and another for another name", () => {
    const again = indexOfRows(ownedCard, {
      city: recordedStatement(card).field("owner").objectOf(person).field("home").objectOf(place).field("city"),
      owner: recordedStatement(card).field("owner").objectOf(person).field("name"),
      title: recordedStatement(card).field("title"),
      card: recordedStatement(card).link,
    });
    const linkOfNamed = (name: string, index = ownedCards) => index.orderedBy("title").named(name).definition?.link;
    expect(linkOfNamed("Owned Cards", again)).toBe(linkOfNamed("Owned Cards"));
    expect(linkOfNamed("Cards")).not.toBe(linkOfNamed("Owned Cards"));
  });

  it("is absent where a function gives the rows of a part", () => {
    const shouted = indexOver(selectedRecords(objectsOf(card)), titled, ({ data }) => [{ title: data.title }]);
    const titles = indexOfRows(titled, { title: recordedCard.field("title") });
    expect(titles.union(shouted).orderedBy("title").named("Titles").definition).toBeUndefined();
    expect(shouted.orderedBy("title").named("Titles").definition).toBeUndefined();
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
