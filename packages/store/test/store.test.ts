import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner, schemeSchema } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  type JsonObject,
  json,
  jsonSchema,
  jsonSchemaRoot,
  type Link,
  linkOf,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Backend, MemoryBackend, RefusedBatch, Store } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const { identities, signatures, publish } = await loadIdentity(defaultValidator, [ed25519]);
const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(7));
const signatureSchemas = [signatures.schema, identities.encode(signer.key, { at: 0 }).schema].map(({ bytes }) => bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);

const newStore = (backend: Backend = new MemoryBackend()) => new Store(json, backend);

const backendGiving = (backend: Backend, under: Link<unknown>, other: Link<unknown>): Backend => ({
  get: (link) => backend.get(link === under ? other : link),
  has: (link) => backend.has(link),
  put: (blobs, records) => backend.put(blobs, records),
  records: (start) => backend.records(start),
  blobs: (start) => backend.blobs(start),
});

async function recordsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

describe("a store", () => {
  it("gives a blob back by its link, and nothing for a link it does not hold", async () => {
    const store = newStore();
    const image = utf8("not an object");
    await store.write({
      records: [object({ image: { $link: linkOf(image) } })],
      blobs: [image, ...anything.blobs],
    });
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("refuses to give a blob when its backend gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [keptObject, other] = [object({ text: "kept" }), object({ text: "other" })];
    await newStore(backend).write({ records: [keptObject, other], blobs: anything.blobs });
    const store = newStore(backendGiving(backend, keptObject.link, other.link));
    await expect(store.get(keptObject.link)).rejects.toThrow(`another blob under ${keptObject.link}`);
  });

  it("lists its records, and not the blobs written with them", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    await store.write({ records: [note], blobs: [image, ...anything.blobs] });
    expect(await recordsOf(store)).toEqual([note.link]);
    expect(await store.get(linkOf(image))).toEqual(image);
  });

  it("keeps of the blobs written with its records only those in their closures", async () => {
    const store = newStore();
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const incomplete = object({ image: { $link: linkOf(utf8("held nowhere")) } });
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    await store.write({
      records: [note],
      blobs: [image, stray, incomplete.bytes, ...anything.blobs, ...signatureSchemas],
    });
    expect(await store.get(linkOf(image))).toEqual(image);
    for (const link of [linkOf(stray), incomplete.link, ...signatureSchemas.map(linkOf)])
      expect(await store.get(link)).toBeUndefined();
    await store.write({ blobs: [image, stray] });
    expect(await store.get(linkOf(stray))).toBeUndefined();
  });

  it("lists an object once, however many times it is written", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write({ records: [note, note], blobs: anything.blobs });
    await store.write({ records: [note] });
    expect(await recordsOf(store)).toEqual([note.link]);
  });

  it("lists an object that came in with another once it is written as a record", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const record = object({ received: { $link: note.link } });
    await store.write({ records: [record], blobs: [note.bytes, ...anything.blobs] });
    expect(await recordsOf(store)).toEqual([record.link]);
    await store.write({ records: [note] });
    expect((await recordsOf(store)).sort()).toEqual([record.link, note.link].sort());
  });

  it("refuses a batch with a record that is not an object, and keeps none of it", async () => {
    const store = newStore();
    const carriedObject = object({ text: "carried" });
    const notCanonical = utf8(` ${new TextDecoder().decode(object({ text: "hello" }).bytes)}`);
    await expect(store.write({ records: [{ bytes: notCanonical }], blobs: [carriedObject.bytes] })).rejects.toThrow(
      /is not an object/,
    );
    await expect(store.write({ records: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(/is not an object/);
    expect(await store.get(carriedObject.link)).toBeUndefined();
    expect(await recordsOf(store)).toEqual([]);
  });

  it("refuses a batch in which a blob links to one that neither the batch nor the store holds, and keeps none of it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const carriedObject = object({ text: "carried" });
    await expect(store.write({ records: [note], blobs: [carriedObject.bytes, ...anything.blobs] })).rejects.toThrow(
      `${note.link} links to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    const unheldSchema = await encodeSchema({ $schema: DRAFT, title: "Unheld" }, defaultValidator);
    const writtenRecord = encodeObject(unheldSchema, { text: "hello" });
    await expect(store.write({ records: [writtenRecord] })).rejects.toThrow(
      `${writtenRecord.link} links to ${unheldSchema.link}`,
    );
    expect(await store.get(carriedObject.link)).toBeUndefined();
    expect(await recordsOf(store)).toEqual([]);
  });

  it("takes an object of a schema written to another schema only along with that one too", async () => {
    const store = newStore();
    const keyScheme = await encodeSchema(schemeSchema, defaultValidator);
    const { root: key } = identities.encode(signer.key, { at: 0 });
    await expect(store.write({ records: [key], blobs: [key.schema.bytes, jsonSchemaRoot.bytes] })).rejects.toThrow(
      `${key.schema.link} links to ${keyScheme.link}, which neither the batch nor the store holds`,
    );
    await store.write({ records: [key], blobs: key.schema.blobs });
    expect([...(await store.closure(key.link)).keys()].sort()).toEqual(
      [key.link, key.schema.link, keyScheme.link, jsonSchema.link].sort(),
    );
  });

  it("refuses a batch for what it is with a RefusedBatch, and passes on a backend's own failure as it is", async () => {
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const store = newStore();
    await expect(store.write({ records: [note], blobs: anything.blobs })).rejects.toThrow(RefusedBatch);
    await expect(store.write({ records: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(RefusedBatch);

    const diskError = new Error("the disk is gone");
    const backend = new MemoryBackend();
    const failingStore = newStore({
      get: (link) => backend.get(link),
      has: () => Promise.reject(diskError),
      put: () => Promise.reject(diskError),
      records: (start) => backend.records(start),
      blobs: (start) => backend.blobs(start),
    });
    await expect(failingStore.write({ records: [note], blobs: anything.blobs })).rejects.toBe(diskError);
    await expect(failingStore.write({ records: [note], blobs: [image, ...anything.blobs] })).rejects.toBe(diskError);
  });

  it("takes a batch whose blobs link to blobs it holds from an earlier write", async () => {
    const store = newStore();
    const image = utf8("an image");
    const first = object({ text: "first", image: { $link: linkOf(image) } });
    await store.write({ records: [first], blobs: [image, ...anything.blobs] });
    const second = object({ text: "second", image: { $link: linkOf(image) } });
    await store.write({ records: [second] });
    expect((await recordsOf(store)).sort()).toEqual([first.link, second.link].sort());
  });

  it("takes a string that is a link as a whole as a string, and does not ask for the blob it names", async () => {
    const store = newStore();
    const commitment = object({ hash: linkOf(utf8("a secret")) });
    await store.write({ records: [commitment], blobs: anything.blobs });
    expect(await recordsOf(store)).toEqual([commitment.link]);
    expect([...(await store.closure(commitment.link)).keys()].sort()).toEqual(
      [commitment.link, anything.link, jsonSchema.link].sort(),
    );
  });

  it("puts each blob in after the blobs it links to, so that a write cut short leaves none without its closure", async () => {
    let order: Link<unknown>[] = [];
    const store = newStore(
      new (class extends MemoryBackend {
        override async put(
          blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
          records: Iterable<Link<never>>,
        ): Promise<void> {
          order = [...blobs.keys()];
          await super.put(blobs, records);
        }
      })(),
    );
    const image = utf8("an image");
    const inner = object({ image: { $link: linkOf(image) } });
    const outer = object({ inner: { $link: inner.link } });
    await store.write({ records: [outer], blobs: [inner.bytes, image, ...anything.blobs] });
    expect(order).toEqual([jsonSchema.link, anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const givenBytes = new Uint8Array(note.bytes);
    await store.write({ records: [{ bytes: givenBytes }], blobs: anything.blobs });
    givenBytes.fill(0);
    const gottenBytes = await store.get(note.link);
    gottenBytes?.fill(0);
    expect(await store.get(note.link)).toEqual(note.bytes);
  });
});

describe("the closure of a blob", () => {
  it("holds the blob, the blobs it links to and theirs in turn, its schema among them", async () => {
    const store = newStore();
    const image = utf8("an image");
    const inner = object({ image: { $link: linkOf(image) } });
    const outer = object({ inner: { $link: inner.link } });
    await store.write({ records: [outer], blobs: [inner.bytes, image, ...anything.blobs] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, inner.link, linkOf(image), anything.link, jsonSchema.link].sort(),
    );
    expect(closure.get(inner.link)).toEqual(inner.bytes);
  });

  it("follows no link out of a blob that is not an object of the store's encoding", async () => {
    const store = newStore();
    const target = object({ text: "target" });
    const bytes = [
      utf8(`see ${target.link}`),
      utf8(` ${JSON.stringify([{ $link: target.link }])}`),
      json.encode([{ $link: target.link }]),
      json.encode({ $schema: DRAFT, properties: { target: { $link: target.link } } }),
    ];
    const outer = object({ attachments: bytes.map((blob) => ({ $link: linkOf(blob) })) });
    await store.write({ records: [outer], blobs: [...bytes, target.bytes, ...anything.blobs] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, ...bytes.map((blob) => linkOf(blob)), anything.link, jsonSchema.link].sort(),
    );
    expect(await store.get(target.link)).toBeUndefined();
  });

  it("is refused when the backend gives other bytes under a link in it", async () => {
    const backend = new MemoryBackend();
    const [inner, other] = [object({ text: "inner" }), object({ text: "other" })];
    const outer = object({ inner: { $link: inner.link } });
    await newStore(backend).write({
      records: [outer, other],
      blobs: [inner.bytes, ...anything.blobs],
    });
    const store = newStore(backendGiving(backend, inner.link, other.link));
    await expect(store.closure(outer.link)).rejects.toThrow(`another blob under ${inner.link}`);
  });

  it("is refused when the backend no longer gives a blob in it", async () => {
    const backend = new MemoryBackend();
    const [inner, absent] = [object({ text: "inner" }), object({ text: "absent" })];
    const outer = object({ inner: { $link: inner.link } });
    await newStore(backend).write({ records: [outer], blobs: [inner.bytes, ...anything.blobs] });
    const store = newStore(backendGiving(backend, inner.link, absent.link));
    await expect(store.closure(outer.link)).rejects.toThrow(`the store does not hold ${inner.link}`);
  });

  it("is refused for a link the store does not hold", async () => {
    const { link } = object({ text: "absent" });
    await expect(newStore().closure(link)).rejects.toThrow(`the store does not hold ${link}`);
  });
});

describe("a signature read from a store", () => {
  it("verifies with the blobs of its signed identity, which the store holds", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const signature = await signatures.actor(signer, await publish(signer, { at: 0 })).sign(note);
    await store.write({
      records: [note, signature],
      blobs: [...signature.signedIdentity.blobs, ...anything.blobs, ...signatureSchemas],
    });
    const readSignature = await signatures.read(signature.link, store, noIdentityVersions);
    expect(readSignature.object).toBe(note.link);
    expect(readSignature.signedIdentity.identity.root.publicKey).toEqual(signer.key.publicKey);
  });

  it("is refused when the store holds another kind of object under its link", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write({ records: [note], blobs: anything.blobs });
    // @ts-expect-error: refused at compile time too
    await expect(signatures.read(note.link, store, noIdentityVersions)).rejects.toThrow(/is written to/);
  });

  it("fails to read when the store does not hold it", async () => {
    const store = newStore();
    const link = linkOf(utf8("absent"));
    await expect(signatures.read(link, store, noIdentityVersions)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
