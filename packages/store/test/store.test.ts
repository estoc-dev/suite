import { SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, json, linkOf, loadSignatures, type Json, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "../src/index.ts";

const anything = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);
const signatures = await loadSignatures(defaultValidator);
const signer = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(7));
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: Json) => encodeObject(anything, data);
const newStore = () => new Store(json, new MemoryBackend());

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

describe("a store", () => {
  it("gives a blob back by its link, and nothing for a link it does not hold", async () => {
    const store = newStore();
    const image = utf8("not an object");
    await store.write({ blobs: [image] });
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("lists what is written as mine, and not the blobs written with it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: linkOf(image) });
    await store.write({ mine: [note], blobs: [image] });
    expect(await listed(store)).toEqual([note.link]);
    expect(await store.get(linkOf(image))).toEqual(image);
  });

  it("lists an object once, however many times it is written", async () => {
    const store = newStore();
    const note = object("hello");
    await store.write({ mine: [note, note] });
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("lists an object that came in with another once it is written as mine", async () => {
    const store = newStore();
    const note = object("hello");
    await store.write({ blobs: [note.bytes] });
    expect(await listed(store)).toEqual([]);
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("refuses a batch with something written as mine that is not an object, and keeps none of it", async () => {
    const store = newStore();
    const carried = object("carried");
    const notCanonical = utf8(` ${new TextDecoder().decode(object("hello").bytes)}`);
    await expect(store.write({ mine: [{ bytes: notCanonical }], blobs: [carried.bytes] })).rejects.toThrow(/is not an object/);
    await expect(store.write({ mine: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(/is not an object/);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = newStore();
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
  it("holds the blob, the blobs it links to and theirs in turn, its schema among them when held", async () => {
    const store = newStore();
    const image = utf8("an image");
    const inner = object({ image: linkOf(image) });
    const outer = object([inner.link]);
    await store.write({ mine: [outer], blobs: [inner.bytes, image, anything.bytes] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual([outer.link, inner.link, linkOf(image), anything.link].sort());
    expect(closure.get(inner.link)).toEqual(inner.bytes);
  });

  it("leaves out a blob the store does not hold, and what it would lead to", async () => {
    const store = newStore();
    const deepest = object("deepest");
    const missing = object([deepest.link]);
    const outer = object([missing.link]);
    await store.write({ mine: [outer], blobs: [deepest.bytes] });
    expect([...(await store.closure(outer.link)).keys()]).toEqual([outer.link]);
  });

  it("follows no link out of a blob that is not of the store's encoding", async () => {
    const store = newStore();
    const target = object("target");
    const text = utf8(`see ${target.link}`);
    const indented = utf8(` ${JSON.stringify([target.link])}`);
    const outer = object([linkOf(text), linkOf(indented)]);
    await store.write({ mine: [outer], blobs: [text, indented, target.bytes] });
    expect([...(await store.closure(outer.link)).keys()].sort()).toEqual([outer.link, linkOf(text), linkOf(indented)].sort());
  });

  it("is empty for a link the store does not hold", async () => {
    expect((await newStore().closure(object("absent").link)).size).toBe(0);
  });
});

describe("an object read from a store", () => {
  it("is read through a semantics, with the blobs its reading follows", async () => {
    const store = newStore();
    const note = object("hello");
    const signature = await signatures.sign(note, signer);
    await store.write({ mine: [note, signature], blobs: [signature.identity.bytes] });
    const read = await store.read(signatures, signature.link);
    expect(read.object).toBe(note.link);
    expect(read.identity.publicKey).toEqual(signer.identity.publicKey);
  });

  it("fails to read when a blob that its reading follows is not held", async () => {
    const store = newStore();
    const signature = await signatures.sign(object("hello"), signer);
    await store.write({ mine: [signature] });
    await expect(store.read(signatures, signature.link)).rejects.toThrow(`no blob is given for ${signature.identity.link}`);
  });

  it("is refused by a semantics that does not read its schema", async () => {
    const store = newStore();
    const note = object("hello");
    await store.write({ mine: [note] });
    // @ts-expect-error: refused at compile time too
    await expect(store.read(signatures, note.link)).rejects.toThrow(/not read here/);
  });

  it("fails to read when the store does not hold it", async () => {
    const link = linkOf(utf8("absent"));
    await expect(newStore().read(signatures, link)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
