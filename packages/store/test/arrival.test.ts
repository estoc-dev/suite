import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { type EncodedObject, encodeObject, LinkValue } from "@estoc/object";
import { link, optional, schema, secretSchema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { arrivalsView, Intake, MemoryBackend, recordsOf, Store, view } from "../src/index.ts";

// A letter names the card of whoever wrote it and may enclose a note, so the closure of a letter
// holds an object of the schema the view is made for and one of another.
const cardSchema = schema("Card", { name: string() });
const noteSchema = schema("Note", { text: string() });
const letterSchema = schema("Letter", { text: string(), from: link(), enclosedNote: optional(link()) });

const card = (name: string) => encodeObject(cardSchema, { name });
const note = (text: string) => encodeObject(noteSchema, { text });
const letter = (text: string, from: EncodedObject, enclosedNote?: EncodedObject) =>
  encodeObject(letterSchema, {
    text,
    from: new LinkValue(from.link),
    ...(enclosedNote === undefined ? {} : { enclosedNote: new LinkValue(enclosedNote.link) }),
  });

const blobsWith = (...objects: readonly EncodedObject[]) => [
  ...objects.map(({ bytes }) => bytes),
  ...cardSchema.blobs,
  ...noteSchema.blobs,
  ...letterSchema.blobs,
];

// Made once, as a program keeps a view, so that a store keeps its rows between scans.
const arrivalsOfCards = arrivalsView(cardSchema);

function sides() {
  const backend = new MemoryBackend();
  const store = new Store(backend);
  let now = 0;
  const intake = new Intake(store, () => now);
  return {
    store,
    arrivals: () => view(store, arrivalsOfCards),
    async receive(at: number, root: EncodedObject, ...others: readonly EncodedObject[]) {
      now = at;
      await intake.receive(decodeBundle(encodeBundle(root.link, [root.bytes, ...blobsWith(...others)])));
    },
    async record(at: number, root: EncodedObject, ...others: readonly EncodedObject[]) {
      await store.write({ roots: [root.link], blobs: blobsWith(root, ...others) });
      await store.writeMarks(recordsOf([root.link], at));
    },
  };
}

describe("when something came to a user's devices, by the marks of a store", () => {
  it("is when its bundle came in, for the root of a bundle", async () => {
    const { receive, arrivals } = sides();
    const ada = card("Ada");
    const hello = letter("hello", ada);
    await receive(5, hello, ada);

    expect(await (await arrivals()).atOf(hello.link)).toBe(5);
  });

  it("is when the user wrote it, for a recorded object", async () => {
    const { record, arrivals } = sides();
    const ada = card("Ada");
    const hello = letter("hello", ada);
    await record(7, hello, ada);

    expect(await (await arrivals()).atOf(hello.link)).toBe(7);
  });

  it("is that of the root, for an object of the schema in the closure of a root", async () => {
    const { receive, record, arrivals } = sides();
    const [ada, ben] = [card("Ada"), card("Ben")];
    await receive(5, letter("hello", ada), ada);
    await record(7, letter("hi", ben), ben);

    const arrivalTimes = await arrivals();
    expect(await arrivalTimes.atOf(ada.link)).toBe(5);
    expect(await arrivalTimes.atOf(ben.link)).toBe(7);
  });

  it("is that of the root, for an object in a closure that holds a Secret as well", async () => {
    const { store, record, arrivals } = sides();
    const ada = card("Ada");
    const secret = encodeObject(secretSchema, { bytes: Uint8Array.of(7) });
    await store.write({ roots: [secret.link], blobs: [secret.bytes, ...secretSchema.blobs] });
    await record(7, letter("the key is enclosed", ada, secret), ada);

    expect(await (await arrivals()).atOf(ada.link)).toBe(7);
  });

  it("is the earliest, for what several marks have", async () => {
    const { receive, record, arrivals } = sides();
    const ada = card("Ada");
    const hello = letter("hello", ada);
    await receive(9, hello, ada);
    await record(4, letter("an earlier draft", ada), ada);
    await receive(6, hello, ada);

    const arrivalTimes = await arrivals();
    expect(await arrivalTimes.atOf(hello.link)).toBe(6);
    expect(await arrivalTimes.atOf(ada.link)).toBe(4);
  });

  it("is nothing for a blob of a closure that is of another schema", async () => {
    const { receive, arrivals } = sides();
    const [ada, enclosedNote] = [card("Ada"), note("see you soon")];
    await receive(5, letter("hello", ada, enclosedNote), ada, enclosedNote);

    const arrivalTimes = await arrivals();
    expect(await arrivalTimes.atOf(enclosedNote.link)).toBeUndefined();
    expect(await arrivalTimes.atOf(letterSchema.link)).toBeUndefined();
  });

  it("is nothing for what the store holds with no mark of it", async () => {
    const { store, arrivals } = sides();
    const ada = card("Ada");
    await store.write({ roots: [ada.link], blobs: blobsWith(ada) });

    expect(await (await arrivals()).atOf(ada.link)).toBeUndefined();
  });

  it("takes in what is marked after, when viewed again", async () => {
    const { receive, arrivals } = sides();
    const [ada, ben] = [card("Ada"), card("Ben")];
    await receive(5, letter("hello", ada), ada);
    const before = await arrivals();
    await receive(8, letter("hi", ben), ben);

    expect(await before.atOf(ben.link)).toBeUndefined();
    expect(await (await arrivals()).atOf(ben.link)).toBe(8);
  });
});
