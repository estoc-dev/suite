import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  objectsOf,
  readObject,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it } from "vitest";
import { indexOver, MemoryBackend, recordsOf, Store, scan, selectedRecords } from "../src/index.ts";

// Two people, each with a store, handing each other bundles. What one writes is in their store,
// with a record of it; what comes from the other is kept in the store, with a mark that says it
// was received, and is read by following links from that mark.

const noteSchema = schema("Note", { text: string() });
const replySchema = schema("Reply", { text: string(), inReplyTo: link() });
const receivedSchema = schema("Received", { bundle: link<never>() });
const contactSchema = schema("Contact", { name: string() });

// Both people run one application, which gives its schemas with each write;
// the store keeps those that what is written names.
const schemas = [noteSchema, replySchema, receivedSchema, contactSchema].flatMap(({ blobs }) => blobs);
const newStore = () => new Store(new MemoryBackend());

async function marksOf<F extends ValueMap>(store: Store, schema: Schema<F>): Promise<EncodedObject<F>[]> {
  const marks: EncodedObject<F>[] = [];
  for await (const link of store.marks()) {
    const mark = await objectsOf(schema).read(link, store);
    if (mark !== undefined) marks.push(mark);
  }
  return marks;
}

async function receive(store: Store, file: Uint8Array) {
  const bundle = decodeBundle(file);
  await store.write({ roots: [bundle.link], blobs: [...schemas, ...bundle.blobs()] });
  const received = encodeObject(receivedSchema, { bundle: new LinkValue(bundle.link) });
  await store.writeMarks({ marks: [received.link], blobs: [received.bytes, ...receivedSchema.blobs] });
  return received;
}

const replyTo = (object: { readonly link: Link<unknown> }, text: string) =>
  encodeObject(replySchema, { text, inReplyTo: new LinkValue(object.link) });

describe("a reply", () => {
  it("travels as a bundle of its closure, and is read where it arrives through the mark written on receiving it", async () => {
    const aliceStore = newStore();
    const note = encodeObject(noteSchema, { text: "hello" });
    const reply = replyTo(note, "hello yourself");
    await aliceStore.write({ roots: [reply.link], blobs: [note.bytes, reply.bytes, ...schemas] });
    const file = encodeBundle(reply.link, (await aliceStore.closure(reply.link)).values());

    const bob = newStore();
    const received = await receive(bob, file);

    const [readReceived, ...others] = await marksOf(bob, receivedSchema);
    assert.exists(readReceived);
    expect(readReceived.link).toBe(received.link);
    expect(others).toEqual([]);
    const readReply = await readObject(bob, readReceived.data.bundle.link, replySchema);
    expect(readReply.data.text).toBe("hello yourself");
    expect((await readObject(bob, readReply.data.inReplyTo.link, noteSchema)).data.text).toBe("hello");
  });
});

describe("a bundle that leaves out a blob in its objects' closures", () => {
  it("is refused, and no mark is written of it", async () => {
    const bob = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const reply = replyTo(note, "and hi again");
    const file = encodeBundle(reply.link, [reply.bytes]);
    await expect(receive(bob, file)).rejects.toThrow(`${reply.link} links to ${note.link}`);
    expect(await bob.get(reply.link)).toBeUndefined();
    expect(await marksOf(bob, receivedSchema)).toEqual([]);
  });
});

describe("an object slipped into a bundle", () => {
  it("is not kept when it is outside the closure of the bundle's root", async () => {
    const bob = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const reply = replyTo(note, "and hi again");
    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    await receive(bob, encodeBundle(reply.link, [reply.bytes, note.bytes, slippedContact.bytes]));
    expect(await bob.get(note.link)).toEqual(note.bytes);
    expect(await bob.get(slippedContact.link)).toBeUndefined();
  });

  it("is not among what the receiver recorded when it is in the closure of the bundle's root, though it is of a schema the receiver writes", async () => {
    const bob = newStore();
    const contact = encodeObject(contactSchema, { name: "Alice" });
    await bob.write({ roots: [contact.link], blobs: [contact.bytes, ...schemas] });
    await bob.writeMarks(recordsOf([contact.link], Date.now()));

    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    const reply = replyTo(slippedContact, "a friend of yours");
    await receive(bob, encodeBundle(reply.link, [reply.bytes, slippedContact.bytes]));

    expect((await readObject(bob, slippedContact.link, contactSchema)).data.name).toBe("Mallory, a friend of Bob's");
    const byName = indexOver(selectedRecords(objectsOf(contactSchema)), contactSchema, ({ data }) => [data]).orderedBy(
      "name",
    );
    const names: string[] = [];
    for await (const { data } of (await scan(bob, byName)).range([])) names.push(data.name);
    expect(names).toEqual(["Alice"]);
  });
});
