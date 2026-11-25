import { decodeObject, encodeObject, type Link, LinkValue, linkOf, objectsOf, type ValueMap } from "@estoc/object";
import { link, rootSchema, schema, string } from "@estoc/schema";
import {
  type Backend,
  indexOver,
  MemoryBackend,
  Store,
  selectedRecords,
  writtenObjectSchema,
  writtenObjectsOf,
} from "@estoc/store";
import { describe, expect, it, onTestFinished } from "vitest";
import { callSchema, replySchema } from "../src/calls.ts";
import { type Channel, Client } from "../src/index.ts";
import { listOfIndex } from "../src/list.ts";
import { heldBlobSchema, heldLinkSchema, heldObjectSchema, Runtime, recordedStatementSchema } from "../src/runtime.ts";
import { channelEnds, clientOf, image, note, noteBlobs, noteSchema, storeOfNote } from "./fixtures.ts";

const heldBlobsIn = (rows: readonly Uint8Array[]) => rows.map((bytes) => decodeObject(bytes, heldBlobSchema).data);

const linkPairsIn = (rows: readonly Uint8Array[]) =>
  rows.map((bytes) => decodeObject(bytes, heldLinkSchema).data).map(({ target, source }) => [target.link, source.link]);

const objectPairsIn = (rows: readonly Uint8Array[]) =>
  rows
    .map((bytes) => decodeObject(bytes, heldObjectSchema).data)
    .map(({ schema, object }) => [schema.link, object.link]);

const sortedPairs = (pairs: [string, string][]) => [...pairs].sort();

function backendNoting(requestedLinks: Link<unknown>[]): Backend {
  const backend = new MemoryBackend();
  return {
    get(link) {
      requestedLinks.push(link);
      return backend.get(link);
    },
    has: (link) => backend.has(link),
    put: (blobs) => backend.put(blobs),
    blobs: (start) => backend.blobs(start),
  };
}

function answerEach(far: Channel, resultOf: (name: string) => ValueMap): void {
  far.receive(
    (message) => {
      const { id, name } = decodeObject(message, callSchema).data;
      far.send(encodeObject(replySchema, { id, result: resultOf(name) }).bytes);
    },
    () => {},
  );
}

describe("a client of a runtime", () => {
  it("reads a blob the store holds, and nothing under a link it does not hold", async () => {
    const client = clientOf(await storeOfNote());
    expect(await client.get(note.link)).toEqual(note.bytes);
    expect(await client.get(linkOf(image))).toEqual(image);
    expect(await client.get(linkOf(new Uint8Array([1])))).toBeUndefined();
  });

  it("lists Records, Blobs, Schemas and Links, each by its order and by what it reads", async () => {
    const client = clientOf(await storeOfNote());
    expect((await client.lists()).map(({ data }) => data)).toEqual([
      { name: "Records", rows: new LinkValue(recordedStatementSchema.link), order: [], readsBlobs: false },
      { name: "Blobs", rows: new LinkValue(heldBlobSchema.link), order: [], readsBlobs: true },
      { name: "Schemas", rows: new LinkValue(heldObjectSchema.link), order: ["schema", "object"], readsBlobs: true },
      { name: "Links", rows: new LinkValue(heldLinkSchema.link), order: ["target", "source"], readsBlobs: true },
    ]);
  });

  it("reads the schema that the rows of a list are written to, though the store does not hold it", async () => {
    const store = await storeOfNote();
    const client = clientOf(store);
    for (const rowSchema of [recordedStatementSchema, heldBlobSchema, heldObjectSchema, heldLinkSchema]) {
      expect(await store.get(rowSchema.link)).toBeUndefined();
      expect(await client.get(rowSchema.link)).toEqual(rowSchema.bytes);
    }
  });

  it("reads a page of Blobs as a row for each blob, in the order written, with its size and the schema it names", async () => {
    const client = clientOf(await storeOfNote());
    const page = await client.page("Blobs", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 4, blobCount: 4 });
    expect(heldBlobsIn(page.rows)).toEqual([
      { blob: new LinkValue(rootSchema.link), size: rootSchema.bytes.length, schema: new LinkValue(rootSchema.link) },
      { blob: new LinkValue(noteSchema.link), size: noteSchema.bytes.length, schema: new LinkValue(rootSchema.link) },
      { blob: new LinkValue(linkOf(image)), size: image.length },
      { blob: new LinkValue(note.link), size: note.bytes.length, schema: new LinkValue(noteSchema.link) },
    ]);
  });

  it.each([
    ["from where it starts, up to its limit", 1, 2, 1, [1, 2]],
    ["up to the end of the list where its limit goes past", 3, 10, 3, [3]],
    ["counted from the end where its start is below zero", -2, 10, 2, [2, 3]],
    ["from the front where its start is further below zero than the list is long", -10, 2, 0, [0, 1]],
    ["of no rows at the end of the list where its start is past the end", 9, 2, 4, []],
    ["of no rows where its limit is below one", 1, -1, 1, []],
  ])("reads a page %s", async (_, start, limit, pageStart, blobs) => {
    const client = clientOf(await storeOfNote());
    const page = await client.page("Blobs", start, limit);
    expect(page).toMatchObject({ start: pageStart, rowCount: 4, blobCount: 4 });
    const links = noteBlobs.map((bytes) => linkOf(bytes));
    expect(heldBlobsIn(page.rows).map(({ blob }) => blob.link)).toEqual(blobs.map((at) => links[at]));
  });

  it("reads a page with the blobs written since the one before", async () => {
    const store = await storeOfNote();
    const client = clientOf(store);
    expect(await client.page("Blobs", -1, 1)).toMatchObject({ start: 3, blobCount: 4 });
    const later = encodeObject(noteSchema, { text: "written later" });
    await store.write({ roots: [later.link], blobs: [later.bytes] });
    const page = await client.page("Blobs", -1, 1);
    expect(page).toMatchObject({ start: 4, rowCount: 5, blobCount: 5 });
    expect(heldBlobsIn(page.rows)).toMatchObject([{ blob: new LinkValue(later.link) }]);
  });

  it("reads a page of Records as a row for each statement recorded, in the order recorded, with its schema", async () => {
    const store = await storeOfNote();
    const first = writtenObjectsOf([note.link], 1);
    const second = writtenObjectsOf([linkOf(image)], 2);
    await store.record(first);
    await store.record(second);
    const page = await clientOf(store).page("Records", 0, 10);
    // The note, the statements and their schema, and a Record of each with the schema of Records.
    expect(page).toMatchObject({ start: 0, rowCount: 2, blobCount: 10 });
    expect(page.rows.map((bytes) => decodeObject(bytes, recordedStatementSchema).data)).toEqual(
      [...first.statements, ...second.statements].map((statement) => ({
        statement: new LinkValue(statement),
        schema: new LinkValue(writtenObjectSchema.link),
      })),
    );
  });

  it("reads a page of Records as they were at the blobs it counts, though a statement is recorded while it is read", async () => {
    const backend = new MemoryBackend();
    const writer = await storeOfNote(backend);
    await writer.record(writtenObjectsOf([note.link], 1));
    let recordAfterListing: (() => Promise<void>) | undefined;
    const client = clientOf(
      new Store({
        get: (link) => backend.get(link),
        has: (link) => backend.has(link),
        put: (blobs) => backend.put(blobs),
        async *blobs(start) {
          yield* backend.blobs(start);
          const record = recordAfterListing;
          recordAfterListing = undefined;
          await record?.();
        },
      }),
    );
    const earlier = await client.page("Records", -1, 1);
    const later = writtenObjectsOf([linkOf(image)], 2);
    recordAfterListing = () => writer.record(later);
    expect(await client.page("Records", -1, 1)).toEqual(earlier);
    const page = await client.page("Records", -1, 1);
    // The later statement and its Record.
    expect(page).toMatchObject({ start: 1, rowCount: 2, blobCount: earlier.blobCount + 2 });
    expect(page.rows.map((bytes) => decodeObject(bytes, recordedStatementSchema).data.statement.link)).toEqual(
      later.statements,
    );
  });

  it("reads from the store the statements of a page of Records and no others, once the records were listed", async () => {
    const requestedLinks: Link<unknown>[] = [];
    const store = await storeOfNote(backendNoting(requestedLinks));
    await store.record(writtenObjectsOf([note.link], 1));
    const later = writtenObjectsOf([linkOf(image)], 2);
    await store.record(later);
    const client = clientOf(store);
    await client.page("Records", 0, 10);
    requestedLinks.length = 0;
    await client.page("Records", -1, 1);
    expect(requestedLinks).toEqual(later.statements);
    requestedLinks.length = 0;
    await client.page("Records", 0, 0);
    expect(requestedLinks).toEqual([]);
  });

  it("reads a page of Schemas as a row for each object, sorted by the schema it names and then by the object", async () => {
    const page = await clientOf(await storeOfNote()).page("Schemas", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 3, blobCount: 4 });
    expect(objectPairsIn(page.rows)).toEqual(
      sortedPairs([
        [rootSchema.link, rootSchema.link],
        [rootSchema.link, noteSchema.link],
        [noteSchema.link, note.link],
      ]),
    );
  });

  it("reads a page of Links as a row for each blob an object links to, sorted by that blob and then by the object", async () => {
    const page = await clientOf(await storeOfNote()).page("Links", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 3, blobCount: 4 });
    expect(linkPairsIn(page.rows)).toEqual(
      sortedPairs([
        [rootSchema.link, noteSchema.link],
        [noteSchema.link, note.link],
        [linkOf(image), note.link],
      ]),
    );
  });

  it("reads one row of Links for an object that links to a blob twice", async () => {
    const store = await storeOfNote();
    const pairSchema = schema("Pair", { left: link(), right: link() });
    const target = new LinkValue(linkOf(image));
    const pair = encodeObject(pairSchema, { left: target, right: target });
    await store.write({ roots: [pair.link], blobs: [pair.bytes, ...pairSchema.blobs] });
    const { rows } = await clientOf(store).page("Links", 0, 10);
    expect(linkPairsIn(rows).filter(([, source]) => source === pair.link)).toEqual(
      sortedPairs([
        [pairSchema.link, pair.link],
        [linkOf(image), pair.link],
      ]),
    );
  });

  it("reads a page of a sorted list from where it starts, with the rows of the blobs written since the one before", async () => {
    const store = await storeOfNote();
    const client = clientOf(store);
    expect(await client.page("Links", 1, 1)).toMatchObject({ start: 1, rowCount: 3, blobCount: 4 });
    const later = encodeObject(noteSchema, { text: "written later" });
    await store.write({ roots: [later.link], blobs: [later.bytes] });
    const page = await client.page("Links", -2, 1);
    expect(page).toMatchObject({ start: 2, rowCount: 4, blobCount: 5 });
    expect(page.rows).toHaveLength(1);
  });

  it("reads the objects held that are written to a schema, sorted as links are, and counts those alone", async () => {
    const client = clientOf(await storeOfNote());
    const objects = [rootSchema.link, noteSchema.link].sort();
    expect(await client.objectsOf(rootSchema.link, 0, 10)).toEqual({
      start: 0,
      linkCount: 2,
      blobCount: 4,
      links: objects,
    });
    expect(await client.objectsOf(rootSchema.link, 1, 10)).toMatchObject({ start: 1, links: objects.slice(1) });
    expect(await client.objectsOf(rootSchema.link, -1, 10)).toMatchObject({ start: 1, links: objects.slice(1) });
    expect(await client.objectsOf(rootSchema.link, 0, 1)).toMatchObject({ linkCount: 2, links: objects.slice(0, 1) });
  });

  it("reads no object for a schema that no object held is written to", async () => {
    const client = clientOf(await storeOfNote());
    expect(await client.objectsOf(schema("Unused", {}).link, 0, 10)).toEqual({
      start: 0,
      linkCount: 0,
      blobCount: 4,
      links: [],
    });
  });

  it("reads what links to a blob, and nothing for a blob that nothing held links to", async () => {
    const client = clientOf(await storeOfNote());
    expect(await client.sourcesOf(linkOf(image), 0, 10)).toEqual({
      start: 0,
      linkCount: 1,
      blobCount: 4,
      links: [note.link],
    });
    expect(await client.sourcesOf(rootSchema.link, 0, 10)).toMatchObject({ linkCount: 1, links: [noteSchema.link] });
    expect(await client.sourcesOf(note.link, 0, 10)).toEqual({ start: 0, linkCount: 0, blobCount: 4, links: [] });
  });

  it("reads what links to a blob from where the page starts, up to its limit", async () => {
    const store = await storeOfNote();
    const later = encodeObject(noteSchema, { text: "written later", image: new LinkValue(linkOf(image)) });
    await store.write({ roots: [later.link], blobs: [later.bytes] });
    const sources = [note.link, later.link].sort();
    expect(await clientOf(store).sourcesOf(linkOf(image), 1, 1)).toEqual({
      start: 1,
      linkCount: 2,
      blobCount: 5,
      links: sources.slice(1),
    });
  });

  it.each<[string, (client: Client) => Promise<unknown>]>([
    ["a page of Schemas", (client) => client.page("Schemas", 0, 10)],
    ["a page of Links", (client) => client.page("Links", 0, 10)],
    ["the objects written to a schema", (client) => client.objectsOf(noteSchema.link, 0, 10)],
    ["what links to a blob", (client) => client.sourcesOf(noteSchema.link, 0, 10)],
  ])("reads from the store, for %s, the blobs written since the read before and no others", async (_, read) => {
    const requestedLinks: Link<unknown>[] = [];
    const store = await storeOfNote(backendNoting(requestedLinks));
    const client = clientOf(store);
    await read(client);
    const later = encodeObject(noteSchema, { text: "written later" });
    await store.write({ roots: [later.link], blobs: [later.bytes] });
    requestedLinks.length = 0;
    await read(client);
    expect(requestedLinks).toEqual([later.link]);
    requestedLinks.length = 0;
    await read(client);
    expect(requestedLinks).toEqual([]);
  });

  it("fails a call with the reason the runtime gives", async () => {
    const client = clientOf(await storeOfNote());
    await expect(client.page("Nothing", 0, 1)).rejects.toThrow("there is no list named Nothing");
  });

  it("receives a later reply while the first call is still pending", async () => {
    const backend = new MemoryBackend();
    let giveNote = () => {};
    const noteIsGiven = new Promise<void>((resolve) => {
      giveNote = resolve;
    });
    const slowBackend: Backend = {
      async get(link) {
        if (link === note.link) await noteIsGiven;
        return backend.get(link);
      },
      has: (link) => backend.has(link),
      put: (blobs) => backend.put(blobs),
      blobs: (start) => backend.blobs(start),
    };
    const client = clientOf(await storeOfNote(slowBackend));
    const slowRead = client.get(note.link);
    expect(await client.get(linkOf(image))).toEqual(image);
    giveNote();
    expect(await slowRead).toEqual(note.bytes);
  });

  it("refuses a blob that is not the one the link names", async () => {
    const [near, far] = channelEnds();
    answerEach(far, () => ({ bytes: image }));
    await expect(new Client(near).get(note.link)).rejects.toThrow(`the blob given for ${note.link} is another blob`);
  });

  it("refuses a result that does not fit its call", async () => {
    const [near, far] = channelEnds();
    answerEach(far, () => ({ rows: [] }));
    await expect(new Client(near).page("Blobs", 0, 1)).rejects.toThrow("#/start: left out");
  });

  it.each([
    ["its own end", 0],
    ["the far end", 1],
  ])("fails the calls that wait when %s of the channel closes, and those made after", async (_, closing) => {
    const ends = channelEnds();
    const client = new Client(ends[0]);
    const read = client.get(note.link);
    ends[closing]?.close();
    await expect(read).rejects.toThrow("the channel closed before the reply");
    await expect(client.lists()).rejects.toThrow("the channel is closed");
  });

  it("fails a call that cannot be written, and leaves nothing of it to fail when the channel closes", async () => {
    const [near, far] = channelEnds();
    const client = new Client(near);
    const unhandledRejections: unknown[] = [];
    const keep = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", keep);
    onTestFinished(() => void process.off("unhandledRejection", keep));
    await expect(client.page("Blobs", 0.5, 1)).rejects.toThrow("a number is an integer");
    const read = client.get(note.link);
    far.close();
    await expect(read).rejects.toThrow("the channel closed before the reply");
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandledRejections).toEqual([]);
  });
});

describe("a client of a runtime that is given the list of an index", () => {
  const notedTextSchema = schema("Noted Text", { text: string(), note: link() });
  const notesByText = indexOver(selectedRecords(objectsOf(noteSchema)), notedTextSchema, ({ link, data }) => {
    if (data.text === "unreadable") throw new Error("the index does not read this note");
    return [{ text: data.text, note: new LinkValue(link) }];
  })
    .orderedBy("text")
    .named("Notes by text");
  const notesList = listOfIndex(notesByText);

  async function storeRecording(...texts: readonly string[]): Promise<Store> {
    const store = new Store(new MemoryBackend());
    await recordNotes(store, ...texts);
    return store;
  }

  async function recordNotes(store: Store, ...texts: readonly string[]): Promise<void> {
    const notes = texts.map((text) => encodeObject(noteSchema, { text }));
    await store.record({
      statements: notes.map(({ link }) => link),
      blobs: [...notes.map(({ bytes }) => bytes), ...noteSchema.blobs],
    });
  }

  async function blobCountOf(store: Store): Promise<number> {
    let count = 0;
    for await (const _ of store.blobs()) count += 1;
    return count;
  }

  const textsIn = (rows: readonly Uint8Array[]) => rows.map((bytes) => decodeObject(bytes, notedTextSchema).data.text);

  it("lists it after the lists of what the store holds, by the name, the schema and the order of the index", async () => {
    const lists = await clientOf(await storeRecording(), [notesList]).lists();
    expect(lists.map(({ data }) => data.name)).toEqual(["Records", "Blobs", "Schemas", "Links", "Notes by text"]);
    expect(lists.at(-1)?.data).toEqual({
      name: "Notes by text",
      rows: new LinkValue(notedTextSchema.link),
      order: ["text"],
      readsBlobs: false,
    });
  });

  it("reads the schema that the rows of the index are written to, though the store does not hold it", async () => {
    const store = await storeRecording("a");
    expect(await store.get(notedTextSchema.link)).toBeUndefined();
    expect(await clientOf(store, [notesList]).get(notedTextSchema.link)).toEqual(notedTextSchema.bytes);
  });

  it("reads a page of it as the rows of the index, in the order of the index", async () => {
    const store = await storeRecording("b", "c", "a");
    const client = clientOf(store, [notesList]);
    const blobCount = await blobCountOf(store);
    const page = await client.page("Notes by text", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 3, blobCount });
    expect(textsIn(page.rows)).toEqual(["a", "b", "c"]);
    const lastPage = await client.page("Notes by text", -2, 1);
    expect(lastPage).toMatchObject({ start: 1, rowCount: 3, blobCount });
    expect(textsIn(lastPage.rows)).toEqual(["b"]);
  });

  it("reads a page of it with the rows of what was recorded since the one before", async () => {
    const store = await storeRecording("b");
    const client = clientOf(store, [notesList]);
    expect(textsIn((await client.page("Notes by text", 0, 10)).rows)).toEqual(["b"]);
    await recordNotes(store, "a");
    const page = await client.page("Notes by text", 0, 10);
    expect(page).toMatchObject({ rowCount: 2, blobCount: await blobCountOf(store) });
    expect(textsIn(page.rows)).toEqual(["a", "b"]);
  });

  it("reads a page of it without the rows of what the index fails on", async () => {
    const client = clientOf(await storeRecording("b", "unreadable", "a"), [notesList]);
    const page = await client.page("Notes by text", 0, 10);
    expect(page).toMatchObject({ start: 0, rowCount: 2 });
    expect(textsIn(page.rows)).toEqual(["a", "b"]);
  });

  it("reads a page of it from the rows that whatever else scans the index in that store reads", async () => {
    const store = await storeRecording("a");
    let readCount = 0;
    const countedTexts = indexOver(selectedRecords(objectsOf(noteSchema)), notedTextSchema, ({ link, data }) => {
      readCount += 1;
      return [{ text: data.text, note: new LinkValue(link) }];
    }).orderedBy("text");
    await store.scan(countedTexts);
    const page = await clientOf(store, [listOfIndex(countedTexts.named("Counted texts"))]).page("Counted texts", 0, 1);
    expect(textsIn(page.rows)).toEqual(["a"]);
    expect(readCount).toBe(1);
  });
});

describe("a runtime", () => {
  async function replyTo(call: ValueMap) {
    const [near, far] = channelEnds();
    new Runtime(await storeOfNote(), [], []).serve(far);
    return new Promise<ValueMap>((resolve) => {
      near.receive(
        (message) => resolve(decodeObject(message, replySchema).data),
        () => {},
      );
      near.send(encodeObject(callSchema, call).bytes);
    });
  }

  it.each([
    ["of a name it does not answer", { id: 7, name: "nothing", parameters: {} }, "there is no call named nothing"],
    ["whose parameters are not a map", { id: 7, name: "lists", parameters: 1 }, "the parameters of a call are a map"],
    ["whose parameters do not fit it", { id: 7, name: "blob", parameters: {} }, "#/link: left out"],
  ])("answers a call %s with why it failed", async (_, call, reason) => {
    expect(await replyTo(call)).toEqual({ id: 7, error: expect.stringContaining(reason) });
  });

  it.each([
    ["another list it is given", ["Notes", "Notes"]],
    ["a list of what the store holds", ["Blobs"]],
  ])("is not made with a list named as %s is", async (_, names) => {
    const texts = indexOver(selectedRecords(objectsOf(noteSchema)), schema("Text", { text: string() }), ({ data }) => [
      { text: data.text },
    ]).orderedBy("text");
    const store = await storeOfNote();
    const lists = names.map((name) => listOfIndex(texts.named(name)));
    expect(() => new Runtime(store, lists, [])).toThrow(`two lists are named ${names[0]}`);
  });

  it("closes a channel that brings what is not a call", async () => {
    const [near, far] = channelEnds();
    new Runtime(await storeOfNote(), [], []).serve(far);
    const isClosed = new Promise<void>((resolve) => near.receive(() => {}, resolve));
    near.send(note.bytes);
    await isClosed;
  });
});
