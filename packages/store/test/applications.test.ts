import { readBundle, writeBundle } from "@estoc/bundle";
import {
  ed25519,
  loadIdentity,
  noIdentityVersions,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  signedIdentitySchema,
} from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Fields,
  type Json,
  json,
  type Link,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { array, link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it, vi } from "vitest";
import { indexOverBlobs, MemoryBackend, Store, scan } from "../src/index.ts";

// Two people, each with a store, handing each other bundles. What one writes
// is listed in their store; what comes from the other is kept with a record
// of receiving it, and read by following links from that record.

const { identities, signatures, signedIdentities, identityVersions, publish } = loadIdentity([ed25519]);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const mallory = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, { at: 0 })).sign(object);

const noteSchema = schema("Note", { text: string() });
const receivedSchema = schema("Received", { bundle: link<never>() });
const contactSchema = schema("Contact", { name: string() });
const carriedSchema = schema("Carried", { identityVersions: array(link<SignedIdentityObject>()) });

// Both people run one application, which gives its schemas with each write;
// the store keeps those that what is written names.
const schemas = [noteSchema, receivedSchema, contactSchema, signatures.schema, carriedSchema].map(({ bytes }) => bytes);
const newStore = () => new Store(json, new MemoryBackend());

async function recordsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

async function readListed<F extends Fields<Json>>(
  store: Store,
  schema: Schema<Json, F>,
): Promise<EncodedObject<Json, F>[]> {
  const objects: EncodedObject<Json, F>[] = [];
  for await (const link of store.records()) {
    const bytes = await store.get(link);
    assert.exists(bytes);
    if (schemaOf(bytes, json) === schema.link) objects.push(decodeObject(bytes, schema));
  }
  return objects;
}

async function receive(store: Store, files: ReadonlyMap<string, Uint8Array>) {
  const receivedRecord = encodeObject(receivedSchema, { bundle: { $link: readBundle(files).link } });
  await store.write({ records: [receivedRecord], blobs: [...schemas, ...files.values()] });
  return receivedRecord;
}

describe("a signed note", () => {
  it("travels as a bundle of its closure, and is read where it arrives through the record of receiving it", async () => {
    const aliceStore = newStore();
    const note = encodeObject(noteSchema, { text: "hello" });
    const signature = await sign(note, alice);
    await aliceStore.write({ records: [note, signature], blobs: [...signature.signedIdentity.blobs, ...schemas] });
    const files = writeBundle(signature, (await aliceStore.closure(signature.link)).values());

    const bobStore = newStore();
    const receivedRecord = await receive(bobStore, files);
    expect(await recordsOf(bobStore)).toEqual([receivedRecord.link]);

    const [record] = await readListed(bobStore, receivedSchema);
    assert.exists(record);
    const bundleSignature = await signatures.read(record.data.bundle.$link, bobStore, noIdentityVersions);
    expect(bundleSignature.signedIdentity.identity).toEqual(identities.encode(alice.key, { at: 0 }));
    expect((await readObject(bobStore, bundleSignature.object, noteSchema)).data.text).toBe("hello");
  });
});

describe("a bundle that leaves out a blob in its objects' closures", () => {
  it("is refused, with the record of receiving it", async () => {
    const bobStore = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await sign(note, alice);
    const files = writeBundle(signature, signature.signedIdentity.blobs);
    await expect(receive(bobStore, files)).rejects.toThrow(`${signature.link} links to ${note.link}`);
    expect(await bobStore.get(signature.link)).toBeUndefined();
    expect(await recordsOf(bobStore)).toEqual([]);
  });
});

describe("an object slipped into a bundle", () => {
  it("is not kept when it is outside the closure of the bundle's root", async () => {
    const bobStore = newStore();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await sign(note, mallory);
    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    await receive(
      bobStore,
      writeBundle(signature, [note.bytes, ...signature.signedIdentity.blobs, slippedContact.bytes]),
    );
    expect(await bobStore.get(note.link)).toEqual(note.bytes);
    expect(await bobStore.get(slippedContact.link)).toBeUndefined();
  });

  it("is not listed among the receiver's own when it is in the closure of the bundle's root, though it is of a schema the receiver writes", async () => {
    const bobStore = newStore();
    await bobStore.write({ records: [encodeObject(contactSchema, { name: "Alice" })], blobs: schemas });

    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    const signature = await sign(slippedContact, mallory);
    const receivedRecord = await receive(
      bobStore,
      writeBundle(signature, [slippedContact.bytes, ...signature.signedIdentity.blobs]),
    );

    expect((await readObject(bobStore, slippedContact.link, contactSchema)).data.name).toBe(
      "Mallory, a friend of Bob's",
    );
    expect((await readListed(bobStore, contactSchema)).map(({ data }) => data.name)).toEqual(["Alice"]);
    expect(await recordsOf(bobStore)).toContain(receivedRecord.link);
  });
});

describe("a signed identity that comes in a bundle", () => {
  const identityVersionsHeld = indexOverBlobs(identityVersions.selection, (identityVersion) => [identityVersion]);

  it("is read by its schema wherever it sits in the closure of the bundle's root, unless its root did not sign it", async () => {
    const aliceIdentityVersion = await publish(alice, { at: 5 });
    const forgedIdentityVersion = encodeObject(signedIdentities.schema, {
      identity: { $link: aliceIdentityVersion.identity.link },
      signature: "00".repeat(64),
    });
    const carriedObject = encodeObject(carriedSchema, {
      identityVersions: [
        { $link: aliceIdentityVersion.link },
        { $link: forgedIdentityVersion.link as Link<SignedIdentityObject> },
      ],
    });
    const signature = await sign(carriedObject, mallory);
    const bobStore = newStore();
    await receive(
      bobStore,
      writeBundle(signature, [
        carriedObject.bytes,
        ...aliceIdentityVersion.blobs,
        forgedIdentityVersion.bytes,
        ...signature.signedIdentity.blobs,
      ]),
    );
    expect(await bobStore.get(forgedIdentityVersion.link)).toEqual(forgedIdentityVersion.bytes);

    const rows = [];
    for await (const row of (await scan(bobStore, identityVersionsHeld)).range([])) rows.push(row);
    const expectedRows = [aliceIdentityVersion, signature.signedIdentity]
      .map((signedIdentity) => identityVersions.identityVersionOf(signedIdentity))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(rows).toEqual(expectedRows);
  });

  it("is validated once by a scan", async () => {
    const validate = vi.spyOn(signedIdentitySchema, "validate");
    const identityVersion = await publish(alice, { at: 5 });
    const store = newStore();
    await store.write({ records: [identityVersion], blobs: identityVersion.blobs });

    validate.mockClear();
    await scan(
      store,
      indexOverBlobs(identityVersions.selection, (row) => [row]),
    );
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockRestore();
  });
});
