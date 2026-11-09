import { readBundle, writeBundle } from "@estoc/bundle";
import {
  ed25519,
  loadIdentity,
  noVersions,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
} from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type Json,
  type JsonLink,
  type JsonObject,
  json,
  type Link,
  linkSchema,
  readObject,
  type Schema,
  SelectionBySchema,
  schemaOf,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { assert, describe, expect, it } from "vitest";
import { type Index, indexOverBlobs, MemoryBackend, Store, scan } from "../src/index.ts";

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
const { identities, signatures, signedIdentities, publish } = await loadIdentity(defaultValidator, [ed25519]);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const mallory = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, 0)).sign(object);

const noteSchema = await schemaFor<{ readonly text: string }>("Note", { text: { type: "string" } });
const receivedSchema = await schemaFor<{ readonly bundle: JsonLink<never> }>("Received", { bundle: linkSchema });
const contactSchema = await schemaFor<{ readonly name: string }>("Contact", { name: { type: "string" } });
const carriedSchema = await schemaFor<{ readonly versions: readonly JsonLink<SignedIdentityObject>[] }>("Carried", {
  versions: { type: "array", items: linkSchema },
});

// Both people run one application, which gives its schemas with each write;
// the store keeps those that what is written names.
const schemas = [noteSchema, receivedSchema, contactSchema, signatures.schema, carriedSchema].flatMap(
  ({ blobs }) => blobs,
);
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
    const bundleSignature = await signatures.read(record.data.bundle.$link, bobStore, noVersions);
    expect(bundleSignature.signedIdentity.identity).toEqual(identities.encode(alice.key, 0));
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
  const versionsHeld: Index<readonly [root: Link<unknown>, signedIdentity: Link<unknown>]> = indexOverBlobs(
    new SelectionBySchema(signedIdentities.schema, async ({ link }, reader) => {
      try {
        return await signedIdentities.read(link as Link<SignedIdentityObject>, reader);
      } catch {
        return undefined;
      }
    }),
    ({ identity, link }) => [[identity.root.link, link]],
  );

  it("is read by its schema wherever it sits in the closure of the bundle's root, unless its root did not sign it", async () => {
    const aliceVersion = await publish(alice, 5);
    const forgedVersion = encodeObject(signedIdentities.schema, {
      identity: { $link: aliceVersion.identity.link },
      signature: "00".repeat(64),
    });
    const carried = encodeObject(carriedSchema, {
      versions: [{ $link: aliceVersion.link }, { $link: forgedVersion.link as Link<SignedIdentityObject> }],
    });
    const signature = await sign(carried, mallory);
    const bobStore = newStore();
    await receive(
      bobStore,
      writeBundle(signature, [
        carried.bytes,
        ...aliceVersion.blobs,
        forgedVersion.bytes,
        ...signature.signedIdentity.blobs,
      ]),
    );
    expect(await bobStore.get(forgedVersion.link)).toEqual(forgedVersion.bytes);

    const rows = [];
    for await (const row of (await scan(bobStore, versionsHeld)).range([])) rows.push(row);
    const expectedRows = [aliceVersion, signature.signedIdentity]
      .map(({ identity, link }) => [identity.root.link, link] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(rows).toEqual(expectedRows);
  });
});
