import { readBundle, writeBundle } from "@estoc/bundle";
import { sameIdentity, SoftwareSigner } from "@estoc/identity";
import {
  encodeSchema,
  identitySchema,
  json,
  linkSchema,
  loadSignatures,
  Semantics,
  signatureSchema,
  type Bytes,
  type JsonLink,
  type JsonObject,
  type Link,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "../src/index.ts";

// Two people, each with a store, handing each other bundles. What one writes
// is listed in their store; what comes from the other is kept with a record
// of receiving it, and read by following links from that record.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const schemaFor = (title: string, properties: JsonObject) =>
  encodeSchema(
    { $schema: DRAFT, title, type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    defaultValidator,
  );
const signatures = await loadSignatures(defaultValidator);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const mallory = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));

type Note = { readonly text: string; readonly bytes: Bytes<Note>; readonly link: Link<Note> };
const noteSchema = await schemaFor("Note", { text: { type: "string" } });
const notes: Semantics<Note, string> = new Semantics(
  [{ schema: noteSchema, read: (data, object) => ({ text: (data as { text: string }).text, ...object }) }],
  { schema: noteSchema.link, write: (text) => ({ text }) },
);

// A record that a bundle was received, naming it by its root.
type Received = { readonly bundle: Link<never>; readonly bytes: Bytes<Received>; readonly link: Link<Received> };
const receivedSchema = await schemaFor("Received", { bundle: linkSchema });
const receipts: Semantics<Received, Link<unknown>> = new Semantics(
  [{ schema: receivedSchema, read: (data, object) => ({ bundle: (data as { bundle: JsonLink<never> }).bundle.$link, ...object }) }],
  { schema: receivedSchema.link, write: (bundle) => ({ bundle: { $link: bundle } }) },
);

type Contact = { readonly name: string; readonly bytes: Bytes<Contact>; readonly link: Link<Contact> };
const contactSchema = await schemaFor("Contact", { name: { type: "string" } });
const contacts: Semantics<Contact, string> = new Semantics(
  [{ schema: contactSchema, read: (data, object) => ({ name: (data as { name: string }).name, ...object }) }],
  { schema: contactSchema.link, write: (name) => ({ name }) },
);

// Both people run one application, whose store holds its schemas before
// anything is written to it.
const schemas = [
  noteSchema,
  receivedSchema,
  contactSchema,
  ...(await Promise.all([identitySchema, signatureSchema].map((schema) => encodeSchema(schema, defaultValidator)))),
];
async function newStore(): Promise<Store> {
  const store = new Store(json, new MemoryBackend());
  await store.write({ blobs: schemas.map(({ bytes }) => bytes) });
  return store;
}

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

// Until a store has indexes, a reader goes through all that is listed and
// keeps what reads as its type.
async function readListed<T>(store: Store, semantics: Semantics<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const link of store.mine()) {
    try {
      values.push(await store.read(semantics, link));
    } catch {
      continue;
    }
  }
  return values;
}

async function receive(store: Store, files: ReadonlyMap<string, Uint8Array>): Promise<Received> {
  const received = receipts.encode(readBundle(files).link);
  await store.write({ mine: [received], blobs: files.values() });
  return received;
}

describe("a signed note", () => {
  it("travels as a bundle of its closure, and is read where it arrives through the record of receiving it", async () => {
    const aliceStore = await newStore();
    const note = notes.encode("hello");
    const signature = await signatures.sign(note, alice);
    await aliceStore.write({ mine: [note, signature], blobs: [signature.identity.bytes] });
    const files = writeBundle(signature, (await aliceStore.closure(signature.link)).values());

    const bobStore = await newStore();
    const received = await receive(bobStore, files);
    expect(await listed(bobStore)).toEqual([received.link]);

    const [record] = await readListed(bobStore, receipts);
    const signed = await bobStore.read(signatures, record!.bundle);
    expect(sameIdentity(signed.identity, alice.identity)).toBe(true);
    expect((await bobStore.read(notes, signed.object)).text).toBe("hello");
  });
});

describe("a bundle that leaves out a blob its objects lead to", () => {
  it("is refused, with the record of receiving it", async () => {
    const bobStore = await newStore();
    const note = notes.encode("hi Bob");
    const signature = await signatures.sign(note, alice);
    const files = writeBundle(signature, [signature.identity.bytes]);
    await expect(receive(bobStore, files)).rejects.toThrow(`${signature.link} leads to ${note.link}`);
    expect(await bobStore.get(signature.link)).toBeUndefined();
    expect(await listed(bobStore)).toEqual([]);
  });
});

describe("an object slipped into a bundle", () => {
  it("is not listed among the receiver's own, though it is of a schema the receiver writes", async () => {
    const bobStore = await newStore();
    await bobStore.write({ mine: [contacts.encode("Alice")] });

    const note = notes.encode("hi Bob");
    const signature = await signatures.sign(note, mallory);
    const slipped = contacts.encode("Mallory, a friend of Bob's");
    await receive(bobStore, writeBundle(signature, [note.bytes, signature.identity.bytes, slipped.bytes]));

    expect(await bobStore.get(slipped.link)).toBeDefined();
    expect((await readListed(bobStore, contacts)).map(({ name }) => name)).toEqual(["Alice"]);
  });
});
