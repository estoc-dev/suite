import { readBundle, writeBundle } from "@estoc/bundle";
import { SoftwareSigner, sameIdentity } from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  identitySchema,
  type Json,
  type JsonLink,
  type JsonObject,
  json,
  type Link,
  linkSchema,
  loadSignatures,
  readObject,
  type Schema,
  schemaOf,
  signatureSchema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "../src/index.ts";

// Two people, each with a store, handing each other bundles. What one writes
// is listed in their store; what comes from the other is kept with a record
// of receiving it, and read by following links from that record.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const schemaFor = <F extends Fields<Json> = Fields<Json>>(
  title: string,
  properties: JsonObject,
): Promise<Schema<Json, F>> =>
  encodeSchema(
    {
      $schema: DRAFT,
      title,
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    defaultValidator,
  );
const signatures = await loadSignatures(defaultValidator);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const mallory = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));

const noteSchema = await schemaFor<{ readonly text: string }>("Note", { text: { type: "string" } });
// A record that a bundle was received, naming it by its root.
const receivedSchema = await schemaFor<{ readonly bundle: JsonLink<never> }>("Received", {
  bundle: linkSchema,
});
const contactSchema = await schemaFor<{ readonly name: string }>("Contact", {
  name: { type: "string" },
});

// Both people run one application, which gives its schemas with each write;
// the store keeps those that what is written names.
const schemas = [
  noteSchema,
  receivedSchema,
  contactSchema,
  ...(await Promise.all(
    [identitySchema, signatureSchema].map((schema) => encodeSchema(schema, defaultValidator)),
  )),
].map(({ bytes }) => bytes);
const newStore = () => new Store(json, new MemoryBackend());

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

async function readListed<F extends Fields<Json>>(
  store: Store,
  schema: Schema<Json, F>,
): Promise<EncodedObject<Json, F>[]> {
  const objects: EncodedObject<Json, F>[] = [];
  for await (const link of store.mine()) {
    const bytes = (await store.get(link))!;
    if (schemaOf(bytes, json) === schema.link) objects.push(decodeObject(bytes, schema));
  }
  return objects;
}

async function receive(store: Store, files: ReadonlyMap<string, Uint8Array>) {
  const received = encodeObject(receivedSchema, { bundle: { $link: readBundle(files).link } });
  await store.write({ mine: [received], blobs: [...schemas, ...files.values()] });
  return received;
}

describe("a signed note", () => {
  it("travels as a bundle of its closure, and is read where it arrives through the record of receiving it", async () => {
    const aliceStore = newStore();
    const note = encodeObject(noteSchema, { text: "hello" });
    const signature = await signatures.sign(note, alice);
    await aliceStore.write({
      mine: [note, signature],
      blobs: [signature.identity.bytes, ...schemas],
    });
    const files = writeBundle(signature, (await aliceStore.closure(signature.link)).values());

    const bobStore = newStore();
    const received = await receive(bobStore, files);
    expect(await listed(bobStore)).toEqual([received.link]);

    const [record] = await readListed(bobStore, receivedSchema);
    const signed = await signatures.read(record!.data.bundle.$link, bobStore);
    expect(sameIdentity(signed.identity, alice.identity)).toBe(true);
    expect((await readObject(bobStore, signed.object, noteSchema)).data.text).toBe("hello");
  });
});

describe("a bundle that leaves out a blob its objects lead to", () => {
  it("is refused, with the record of receiving it", async () => {
    const bobStore = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await signatures.sign(note, alice);
    const files = writeBundle(signature, [signature.identity.bytes]);
    await expect(receive(bobStore, files)).rejects.toThrow(
      `${signature.link} leads to ${note.link}`,
    );
    expect(await bobStore.get(signature.link)).toBeUndefined();
    expect(await listed(bobStore)).toEqual([]);
  });
});

describe("an object slipped into a bundle", () => {
  it("is not kept when nothing in the bundle leads to it", async () => {
    const bobStore = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await signatures.sign(note, mallory);
    const slipped = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    await receive(
      bobStore,
      writeBundle(signature, [note.bytes, signature.identity.bytes, slipped.bytes]),
    );
    expect(await bobStore.get(note.link)).toEqual(note.bytes);
    expect(await bobStore.get(slipped.link)).toBeUndefined();
  });

  it("is not listed among the receiver's own when the bundle leads to it, though it is of a schema the receiver writes", async () => {
    const bobStore = newStore();
    await bobStore.write({
      mine: [encodeObject(contactSchema, { name: "Alice" })],
      blobs: schemas,
    });

    const slipped = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    const signature = await signatures.sign(slipped, mallory);
    const received = await receive(
      bobStore,
      writeBundle(signature, [slipped.bytes, signature.identity.bytes]),
    );

    expect((await readObject(bobStore, slipped.link, contactSchema)).data.name).toBe(
      "Mallory, a friend of Bob's",
    );
    expect((await readListed(bobStore, contactSchema)).map(({ data }) => data.name)).toEqual([
      "Alice",
    ]);
    expect(await listed(bobStore)).toContain(received.link);
  });
});
