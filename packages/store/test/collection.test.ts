import {
  blobsOf,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  objectsOf,
  readObject,
} from "@estoc/object";
import { array, type DataOf, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, test } from "vitest";
import {
  collectionOf,
  collectionSchema,
  heldBlobs,
  heldObject,
  indexOfRows,
  indexOver,
  MemoryBackend,
  type Rows,
  recordedStatement,
  Store,
  selectedBlobs,
  selectedRecords,
  sendableBlobs,
} from "../src/index.ts";
import { recordOf } from "../src/record.ts";

const noteSchema = schema("Note", { text: string(), about: optional(link()) });
const note = (text: string, about?: Link<unknown>) =>
  encodeObject(noteSchema, about === undefined ? { text } : { text, about: new LinkValue(about) });

const textSchema = schema("Text", { text: string(), note: link() });
type Text = DataOf<typeof textSchema>;

type TextRows = Rows<Text, readonly ["text"]>;

const texts = indexOfRows(textSchema, {
  text: heldObject(noteSchema).field("text"),
  note: heldObject(noteSchema).link,
});
const heldTexts = texts.orderedBy("text");

const recordedTextIndexes = () => [
  indexOfRows(textSchema, {
    text: recordedStatement(noteSchema).field("text"),
    note: recordedStatement(noteSchema).link,
  }).orderedBy("text"),
  indexOver(selectedRecords(objectsOf(noteSchema)), textSchema, ({ link, data }) => [
    { text: data.text, note: new LinkValue(link) },
  ]).orderedBy("text"),
];

const utf8 = (text: string) => new TextEncoder().encode(text);

const newStore = () => new Store(new MemoryBackend());

async function keepIn(store: Store, objects: readonly EncodedObject[], blobs: Iterable<Uint8Array> = []) {
  await store.write({
    roots: objects.map(({ link }) => link),
    blobs: [...objects.flatMap(blobsOf), ...blobs],
  });
}

async function collectionIn(store: Store, members: readonly Link<unknown>[]) {
  const collection = collectionOf(members);
  await keepIn(store, [collection]);
  return store.heldCollection(collection.link);
}

async function rowDataOf(rows: TextRows): Promise<Text[]> {
  const data: Text[] = [];
  for await (const row of rows.range([])) data.push(row.data);
  return data;
}

const textsOf = async (rows: TextRows) => (await rowDataOf(rows)).map(({ text }) => text);

describe("a collection", () => {
  it("is the same object for the same members, in whatever order and however often they are given", () => {
    const [soup, salad, stew] = [note("soup").link, note("salad").link, note("stew").link];
    const collection = collectionOf([soup, salad, stew]);
    expect(collectionOf([stew, soup, salad, soup]).link).toBe(collection.link);
    expect(collection.data.members.map((member) => member.link)).toEqual([soup, salad, stew].sort());
  });

  it("is another object for other members", () => {
    const [soup, salad] = [note("soup").link, note("salad").link];
    expect(collectionOf([soup]).link).not.toBe(collectionOf([soup, salad]).link);
  });
});

describe("a collection that a store holds", () => {
  it("is given for the link that another object holds to it", async () => {
    const store = newStore();
    const soup = note("soup");
    const inner = collectionOf([soup.link]);
    const outer = collectionOf([inner.link]);
    await keepIn(store, [soup, inner, outer]);

    const listed = (await readObject(store, outer.link, collectionSchema)).data.members;
    const collections = await Promise.all(listed.map(({ link }) => store.heldCollection(link)));
    const textsByCollection = collections.map(async (collection) => textsOf(await collection.scan(heldTexts)));
    expect(await Promise.all(textsByCollection)).toEqual([["soup"]]);
  });

  it("is refused where the object is written to another schema", async () => {
    const store = newStore();
    const soup = note("soup");
    await keepIn(store, [soup]);
    await expect(store.heldCollection(soup.link)).rejects.toThrow(
      `the object is written to ${noteSchema.link}, not to ${collectionSchema.link}`,
    );
  });

  it("is refused where its members are out of the order of their links", async () => {
    const store = newStore();
    const [soup, salad] = [note("soup"), note("salad")];
    const [first, second] = soup.link < salad.link ? [soup, salad] : [salad, soup];
    const unordered = encodeObject(collectionSchema, {
      members: [new LinkValue(second.link), new LinkValue(first.link)],
    });
    await keepIn(store, [unordered, first, second]);
    await expect(store.heldCollection(unordered.link)).rejects.toThrow(
      `${unordered.link} lists ${first.link} after ${second.link}`,
    );
  });

  it("is refused where it lists a member twice", async () => {
    const store = newStore();
    const soup = note("soup");
    const doubled = encodeObject(collectionSchema, { members: [new LinkValue(soup.link), new LinkValue(soup.link)] });
    await keepIn(store, [doubled, soup]);
    await expect(store.heldCollection(doubled.link)).rejects.toThrow(`${doubled.link} lists ${soup.link} twice`);
  });
});

describe("an index scanned over a collection", () => {
  it("holds the rows that it gives in the store of the members, and none of another blob held", async () => {
    const store = newStore();
    const [soup, salad, stew] = [note("soup"), note("salad"), note("stew")];
    await keepIn(store, [soup, salad, stew]);
    const members: Link<unknown>[] = [soup.link, stew.link];
    const collection = await collectionIn(store, members);

    const rowsOfMembers = (await rowDataOf(await store.scan(heldTexts))).filter(({ note }) =>
      members.includes(note.link),
    );
    expect(await rowDataOf(await collection.scan(heldTexts))).toEqual(rowsOfMembers);
    expect(rowsOfMembers.map(({ text }) => text)).toEqual(["soup", "stew"]);
  });

  it("holds the same rows where a function gives them", async () => {
    const store = newStore();
    const [soup, salad] = [note("soup"), note("salad")];
    await keepIn(store, [soup, salad]);
    const collection = await collectionIn(store, [salad.link]);

    const textsByFunction = indexOver(selectedBlobs(objectsOf(noteSchema)), textSchema, ({ link, data }) => [
      { text: data.text, note: new LinkValue(link) },
    ]).orderedBy("text");
    expect(await rowDataOf(await collection.scan(textsByFunction))).toEqual(
      await rowDataOf(await collection.scan(heldTexts)),
    );
    expect(await textsOf(await collection.scan(textsByFunction))).toEqual(["salad"]);
  });

  it("holds the rows of the store where it lists every blob the store holds, of what is recorded as well", async () => {
    const store = newStore();
    const [soup, salad, stew] = [note("soup"), note("salad"), note("stew")];
    await store.record({ statements: [soup.link, stew.link], blobs: [soup.bytes, stew.bytes, ...noteSchema.blobs] });
    await keepIn(store, [salad]);

    const indexes = [heldTexts, ...recordedTextIndexes()];
    const rowsInStore: Text[][] = [];
    for (const index of indexes) rowsInStore.push(await rowDataOf(await store.scan(index)));
    expect(rowsInStore.map((rows) => rows.map(({ text }) => text))).toEqual([
      ["salad", "soup", "stew"],
      ["soup", "stew"],
      ["soup", "stew"],
    ]);

    const heldLinks: Link<unknown>[] = [];
    for await (const blob of store.blobs()) heldLinks.push(blob);
    const collection = await collectionIn(store, heldLinks);
    const rowsInCollection: Text[][] = [];
    for (const index of indexes) rowsInCollection.push(await rowDataOf(await collection.scan(index)));
    expect(rowsInCollection).toEqual(rowsInStore);
  });

  it("holds a row of a statement whose Record is a member, and none where only the statement is", async () => {
    const store = newStore();
    const [soup, salad] = [note("soup"), note("salad")];
    await store.record({ statements: [soup.link, salad.link], blobs: [soup.bytes, salad.bytes, ...noteSchema.blobs] });
    const collection = await collectionIn(store, [recordOf(soup.link).link, salad.link]);

    for (const index of recordedTextIndexes()) {
      expect(await textsOf(await store.scan(index))).toEqual(["salad", "soup"]);
      expect(await textsOf(await collection.scan(index))).toEqual(["soup"]);
    }
    expect(await textsOf(await collection.scan(heldTexts))).toEqual(["salad"]);
  });

  it("reads the closure of a member from the store, and gives no row of its own to what is only there", async () => {
    const store = newStore();
    const soup = note("soup");
    const remark = note("a remark", soup.link);
    await keepIn(store, [remark, soup]);
    const collection = await collectionIn(store, [remark.link]);

    const subjects = indexOver(selectedBlobs(objectsOf(noteSchema)), textSchema, async function* ({ data }, reader) {
      if (data.about === undefined) return;
      const subject = await readObject(reader, data.about.link, noteSchema);
      yield { text: subject.data.text, note: data.about };
    }).orderedBy("text");
    expect(await textsOf(await collection.scan(subjects))).toEqual(["soup"]);
    expect(await textsOf(await collection.scan(heldTexts))).toEqual(["a remark"]);
  });

  it("reads an index that it is over from the members as well", async () => {
    const store = newStore();
    const [soup, salad] = [note("soup"), note("salad")];
    await keepIn(store, [soup, salad]);
    const collection = await collectionIn(store, [soup.link]);

    const shouted = indexOver(texts, textSchema, ({ data }) => [
      { text: data.text.toUpperCase(), note: data.note },
    ]).orderedBy("text");
    expect(await textsOf(await store.scan(shouted))).toEqual(["SALAD", "SOUP"]);
    expect(await textsOf(await collection.scan(shouted))).toEqual(["SOUP"]);
  });

  it("reads a member that is not an object as a blob held", async () => {
    const store = newStore();
    const image = utf8("an image");
    const album = encodeObject(schema("Album", { images: array(link()) }), { images: [new LinkValue(linkOf(image))] });
    await keepIn(store, [album], [image]);
    const collection = await collectionIn(store, [linkOf(image)]);

    const sizes = indexOver(heldBlobs, textSchema, ({ link, bytes }) => [
      { text: String(bytes.length), note: new LinkValue(link) },
    ]).orderedBy("text");
    expect(await rowDataOf(await collection.scan(sizes))).toEqual([
      { text: String(image.length), note: new LinkValue(linkOf(image)) },
    ]);
  });

  it("counts its members as the blobs read, whatever the store comes to hold", async () => {
    const store = newStore();
    const [soup, salad] = [note("soup"), note("salad")];
    await keepIn(store, [soup, salad]);
    const collection = await collectionIn(store, [soup.link, salad.link]);
    expect((await collection.scan(heldTexts)).blobCount).toBe(2);

    await keepIn(store, [note("stew")]);
    const rows = await collection.scan(heldTexts);
    expect(rows.blobCount).toBe(2);
    expect(await textsOf(rows)).toEqual(["salad", "soup"]);
  });

  it("lists the member that it fails on, and throws for it when asked to", async () => {
    const store = newStore();
    const soup = note("soup");
    await keepIn(store, [soup]);
    const collection = await collectionIn(store, [soup.link]);

    const refusal = new Error("no row of soup");
    const refusing = indexOver(selectedBlobs(objectsOf(noteSchema)), textSchema, () => {
      throw refusal;
    }).orderedBy("text");
    expect((await collection.scan(refusing)).failures).toEqual([{ item: soup.link, error: refusal }]);
    await expect(collection.scan(refusing, { throwsOnFailure: true })).rejects.toBe(refusal);
  });
});

test("sendableBlobs refuses the closure of a collection that lists a Record", async () => {
  const store = newStore();
  const soup = note("soup");
  await store.record({ statements: [soup.link], blobs: [soup.bytes, ...noteSchema.blobs] });
  const record = recordOf(soup.link);
  const collection = collectionOf([record.link]);
  await keepIn(store, [collection]);

  const closure = await store.closure(collection.link);
  expect(() => [...sendableBlobs(closure.values())]).toThrow(`${record.link} is a Record, which is not sent`);
});
