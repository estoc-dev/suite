import { SoftwareSigner } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  identitySchema,
  json,
  linkOf,
  loadSignatures,
  signatureSchema,
  type Json,
  type Link,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MemoryBackend, Store, type Backend } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const signatures = await loadSignatures(defaultValidator);
const signatureSchemas = await Promise.all([identitySchema, signatureSchema].map((schema) => encodeSchema(schema, defaultValidator)));
const signer = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(7));
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: Json) => encodeObject(anything, data);

// A store that holds the schemas of the objects written here before anything
// else is written to it.
async function newStore(backend: Backend = new MemoryBackend()): Promise<Store> {
  const store = new Store(json, backend);
  await store.write({ blobs: [anything, ...signatureSchemas].map(({ bytes }) => bytes) });
  return store;
}

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

describe("a store", () => {
  it("gives a blob back by its link, and nothing for a link it does not hold", async () => {
    const store = await newStore();
    const image = utf8("not an object");
    await store.write({ blobs: [image] });
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("lists what is written as mine, and not the blobs written with it", async () => {
    const store = await newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: linkOf(image) });
    await store.write({ mine: [note], blobs: [image] });
    expect(await listed(store)).toEqual([note.link]);
    expect(await store.get(linkOf(image))).toEqual(image);
  });

  it("lists an object once, however many times it is written", async () => {
    const store = await newStore();
    const note = object("hello");
    await store.write({ mine: [note, note] });
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("lists an object that came in with another once it is written as mine", async () => {
    const store = await newStore();
    const note = object("hello");
    await store.write({ blobs: [note.bytes] });
    expect(await listed(store)).toEqual([]);
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("refuses a batch with something written as mine that is not an object, and keeps none of it", async () => {
    const store = await newStore();
    const carried = object("carried");
    const notCanonical = utf8(` ${new TextDecoder().decode(object("hello").bytes)}`);
    await expect(store.write({ mine: [{ bytes: notCanonical }], blobs: [carried.bytes] })).rejects.toThrow(/is not an object/);
    await expect(store.write({ mine: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(/is not an object/);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("refuses a batch in which a blob leads to one that neither the batch nor the store holds, and keeps none of it", async () => {
    const store = await newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: linkOf(image) });
    const carried = object("carried");
    await expect(store.write({ mine: [note], blobs: [carried.bytes] })).rejects.toThrow(
      `${note.link} leads to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    const unheld = await encodeSchema({ $schema: DRAFT, title: "Unheld" }, defaultValidator);
    const written = encodeObject(unheld, "hello");
    await expect(store.write({ mine: [written] })).rejects.toThrow(`${written.link} leads to ${unheld.link}`);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("takes a batch whose blobs lead to blobs it holds from an earlier write", async () => {
    const store = await newStore();
    const image = utf8("an image");
    await store.write({ blobs: [image] });
    const note = object({ text: "hello", image: linkOf(image) });
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("puts each blob in after the blobs it leads to, so that a write cut short leaves none without them", async () => {
    let order: Link<unknown>[] = [];
    const store = await newStore(
      new (class extends MemoryBackend {
        override async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, mine: Iterable<Link<never>>): Promise<void> {
          order = [...blobs.keys()];
          await super.put(blobs, mine);
        }
      })(),
    );
    const image = utf8("an image");
    const inner = object({ image: linkOf(image) });
    const outer = object([inner.link]);
    await store.write({ mine: [outer], blobs: [inner.bytes, image] });
    expect(order).toEqual([linkOf(image), inner.link, outer.link]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = await newStore();
    const note = object("hello");
    const given = new Uint8Array(note.bytes);
    await store.write({ mine: [{ bytes: given }] });
    given.fill(0);
    const gotten = await store.get(note.link);
    gotten?.fill(0);
    expect(await store.get(note.link)).toEqual(note.bytes);
  });
});

describe("the closure of a blob", () => {
  it("holds the blob, the blobs it links to and theirs in turn, its schema among them", async () => {
    const store = await newStore();
    const image = utf8("an image");
    const inner = object({ image: linkOf(image) });
    const outer = object([inner.link]);
    await store.write({ mine: [outer], blobs: [inner.bytes, image] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual([outer.link, inner.link, linkOf(image), anything.link].sort());
    expect(closure.get(inner.link)).toEqual(inner.bytes);
  });

  it("follows no link out of a blob that is not of the store's encoding", async () => {
    const store = await newStore();
    const target = object("target");
    const text = utf8(`see ${target.link}`);
    const indented = utf8(` ${JSON.stringify([target.link])}`);
    const outer = object([linkOf(text), linkOf(indented)]);
    await store.write({ mine: [outer], blobs: [text, indented, target.bytes] });
    expect([...(await store.closure(outer.link)).keys()].sort()).toEqual([outer.link, linkOf(text), linkOf(indented), anything.link].sort());
  });

  it("is empty for a link the store does not hold", async () => {
    const store = await newStore();
    expect((await store.closure(object("absent").link)).size).toBe(0);
  });
});

describe("an object read from a store", () => {
  it("is read through a semantics, with the blobs its reading follows", async () => {
    const store = await newStore();
    const note = object("hello");
    const signature = await signatures.sign(note, signer);
    await store.write({ mine: [note, signature], blobs: [signature.identity.bytes] });
    const read = await store.read(signatures, signature.link);
    expect(read.object).toBe(note.link);
    expect(read.identity.publicKey).toEqual(signer.identity.publicKey);
  });

  it("is refused by a semantics that does not read its schema", async () => {
    const store = await newStore();
    const note = object("hello");
    await store.write({ mine: [note] });
    // @ts-expect-error: refused at compile time too
    await expect(store.read(signatures, note.link)).rejects.toThrow(/not read here/);
  });

  it("fails to read when the store does not hold it", async () => {
    const store = await newStore();
    const link = linkOf(utf8("absent"));
    await expect(store.read(signatures, link)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
