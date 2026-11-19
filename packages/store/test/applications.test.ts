import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  ed25519,
  loadIdentity,
  noIdentityVersions,
  type Signer,
  SoftwareSigner,
  signedIdentitySchema,
} from "@estoc/identity";
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
import { array, link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it, vi } from "vitest";
import {
  indexOver,
  MemoryBackend,
  PrivateStore,
  recordsOf,
  Store,
  scan,
  selectedBlobs,
  selectedRecords,
} from "../src/index.ts";

// Two people, each with a store and a private store beside it, handing each other bundles. What
// one writes is in their store, with a record of it in the private store; what comes from the
// other is kept in the store, with a mark in the private store that says it was received, and is
// read by following links from that mark.

const { identities, signatures, signedIdentities, identityVersions, publish } = loadIdentity([ed25519]);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const mallory = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, { at: 0 })).sign(object);

const noteSchema = schema("Note", { text: string() });
const receivedSchema = schema("Received", { bundle: link<never>() });
const contactSchema = schema("Contact", { name: string() });
const carriedSchema = schema("Carried", { identityVersions: array(link()) });

// Both people run one application, which gives its schemas with each write;
// the store keeps those that what is written names.
const schemas = [noteSchema, receivedSchema, contactSchema, signatures.schema, carriedSchema].flatMap(
  ({ blobs }) => blobs,
);
const newStore = () => new Store(new MemoryBackend());

function newStores() {
  const store = newStore();
  return { store, privateStore: new PrivateStore(store, new MemoryBackend()) };
}
type Stores = ReturnType<typeof newStores>;

async function marksOf<F extends ValueMap>({ privateStore }: Stores, schema: Schema<F>): Promise<EncodedObject<F>[]> {
  const marks: EncodedObject<F>[] = [];
  for await (const link of privateStore.marks()) {
    const mark = await objectsOf(schema).read(link, privateStore);
    if (mark !== undefined) marks.push(mark);
  }
  return marks;
}

async function receive({ store, privateStore }: Stores, file: Uint8Array) {
  const bundle = decodeBundle(file);
  await store.write({ roots: [bundle.link], blobs: [...schemas, ...bundle.blobs()] });
  const received = encodeObject(receivedSchema, { bundle: new LinkValue(bundle.link) });
  await privateStore.write({ marks: [received.link], blobs: [received.bytes, ...receivedSchema.blobs] });
  return received;
}

describe("a signed note", () => {
  it("travels as a bundle of its closure, and is read where it arrives through the mark written on receiving it", async () => {
    const aliceStore = newStore();
    const note = encodeObject(noteSchema, { text: "hello" });
    const signature = await sign(note, alice);
    await aliceStore.write({
      roots: [signature.link],
      blobs: [note.bytes, signature.bytes, ...signature.signedIdentity.blobs, ...schemas],
    });
    const file = encodeBundle(signature.link, (await aliceStore.closure(signature.link)).values());

    const bob = newStores();
    const received = await receive(bob, file);

    const [readReceived, ...others] = await marksOf(bob, receivedSchema);
    assert.exists(readReceived);
    expect(readReceived.link).toBe(received.link);
    expect(others).toEqual([]);
    const bundleSignature = await signatures.read(readReceived.data.bundle.link, bob.store, noIdentityVersions);
    expect(bundleSignature.signedIdentity.identity).toEqual(identities.encode(alice.key, { at: 0 }));
    expect((await readObject(bob.store, bundleSignature.object, noteSchema)).data.text).toBe("hello");
  });
});

describe("a bundle that leaves out a blob in its objects' closures", () => {
  it("is refused, and no mark is written of it", async () => {
    const bob = newStores();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await sign(note, alice);
    const file = encodeBundle(signature.link, [signature.bytes, ...signature.signedIdentity.blobs]);
    await expect(receive(bob, file)).rejects.toThrow(`${signature.link} links to ${note.link}`);
    expect(await bob.store.get(signature.link)).toBeUndefined();
    expect(await marksOf(bob, receivedSchema)).toEqual([]);
  });
});

describe("an object slipped into a bundle", () => {
  it("is not kept when it is outside the closure of the bundle's root", async () => {
    const bob = newStores();
    const note = encodeObject(noteSchema, { text: "hi Bob" });
    const signature = await sign(note, mallory);
    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    await receive(
      bob,
      encodeBundle(signature.link, [
        signature.bytes,
        note.bytes,
        ...signature.signedIdentity.blobs,
        slippedContact.bytes,
      ]),
    );
    expect(await bob.store.get(note.link)).toEqual(note.bytes);
    expect(await bob.store.get(slippedContact.link)).toBeUndefined();
  });

  it("is not among what the receiver recorded when it is in the closure of the bundle's root, though it is of a schema the receiver writes", async () => {
    const bob = newStores();
    const contact = encodeObject(contactSchema, { name: "Alice" });
    await bob.store.write({ roots: [contact.link], blobs: [contact.bytes, ...schemas] });
    await bob.privateStore.write(recordsOf([contact.link], Date.now()));

    const slippedContact = encodeObject(contactSchema, { name: "Mallory, a friend of Bob's" });
    const signature = await sign(slippedContact, mallory);
    await receive(
      bob,
      encodeBundle(signature.link, [signature.bytes, slippedContact.bytes, ...signature.signedIdentity.blobs]),
    );

    expect((await readObject(bob.store, slippedContact.link, contactSchema)).data.name).toBe(
      "Mallory, a friend of Bob's",
    );
    const byName = indexOver(selectedRecords(objectsOf(contactSchema)), contactSchema, ({ data }) => [data]).orderedBy(
      "name",
    );
    const names: string[] = [];
    for await (const { data } of (await scan(bob.privateStore, byName)).range([])) names.push(data.name);
    expect(names).toEqual(["Alice"]);
  });
});

describe("a signed identity that comes in a bundle", () => {
  const identityVersionsHeld = indexOver(
    selectedBlobs(identityVersions.selection),
    identityVersions.schema,
    identityVersions.rows,
  ).orderedBy(...identityVersions.order);

  it("is read by its schema wherever it sits in the closure of the bundle's root, and is among the failures when its root did not sign it", async () => {
    const aliceIdentityVersion = await publish(alice, { at: 5 });
    const forgedIdentityVersion = encodeObject(signedIdentities.schema, {
      identity: new LinkValue(aliceIdentityVersion.identity.link),
      signature: new Uint8Array(64),
    });
    const carriedObject = encodeObject(carriedSchema, {
      identityVersions: [new LinkValue(aliceIdentityVersion.link), new LinkValue(forgedIdentityVersion.link)],
    });
    const signature = await sign(carriedObject, mallory);
    const bob = newStores();
    await receive(
      bob,
      encodeBundle(signature.link, [
        signature.bytes,
        carriedObject.bytes,
        ...aliceIdentityVersion.blobs,
        forgedIdentityVersion.bytes,
        ...signature.signedIdentity.blobs,
      ]),
    );
    expect(await bob.store.get(forgedIdentityVersion.link)).toEqual(forgedIdentityVersion.bytes);

    const scannedRows = await scan(bob.store, identityVersionsHeld);
    const rows = [];
    for await (const { data } of scannedRows.range([])) rows.push(data);
    const expectedRows = [aliceIdentityVersion, signature.signedIdentity]
      .map((signedIdentity) => identityVersions.identityVersionOf(signedIdentity))
      .sort((a, b) => (a.identifier.link < b.identifier.link ? -1 : 1));
    expect(rows).toEqual(expectedRows);
    expect(scannedRows.failures.map(({ item }) => item)).toEqual([forgedIdentityVersion.link]);
  });

  it("is validated once by a scan", async () => {
    const validate = vi.spyOn(signedIdentitySchema, "validate");
    const identityVersion = await publish(alice, { at: 5 });
    const store = newStore();
    await store.write({ roots: [identityVersion.link], blobs: [identityVersion.bytes, ...identityVersion.blobs] });

    validate.mockClear();
    await scan(
      store,
      indexOver(selectedBlobs(identityVersions.selection), identityVersions.schema, identityVersions.rows).orderedBy(
        ...identityVersions.order,
      ),
    );
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockRestore();
  });
});
