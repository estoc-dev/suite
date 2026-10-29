import { loadSignatures, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type JsonObject, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Backend, MemoryBackend, Store } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const signatures = await loadSignatures(defaultValidator);
const signer = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(7));
const signatureSchemas = [signatures.schema, signatures.identities.encode(signer.key).schema].map(({ bytes }) => bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);

const newStore = (backend: Backend = new MemoryBackend()) => new Store(json, backend);

const giving = (backend: Backend, under: Link<unknown>, other: Link<unknown>): Backend => ({
  get: (link) => backend.get(link === under ? other : link),
  has: (link) => backend.has(link),
  put: (blobs, mine) => backend.put(blobs, mine),
  mine: () => backend.mine(),
});

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

describe("a store", () => {
  it("gives a blob back by its link, and nothing for a link it does not hold", async () => {
    const store = newStore();
    const image = utf8("not an object");
    await store.write({ mine: [object({ image: { $link: linkOf(image) } })], blobs: [image, anything.bytes] });
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("refuses to give a blob when its backend gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [kept, other] = [object({ text: "kept" }), object({ text: "other" })];
    await newStore(backend).write({ mine: [kept, other], blobs: [anything.bytes] });
    const store = newStore(giving(backend, kept.link, other.link));
    await expect(store.get(kept.link)).rejects.toThrow(`another blob under ${kept.link}`);
  });

  it("lists what is written as mine, and not the blobs written with it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    await store.write({ mine: [note], blobs: [image, anything.bytes] });
    expect(await listed(store)).toEqual([note.link]);
    expect(await store.get(linkOf(image))).toEqual(image);
  });

  it("keeps of the blobs written with what is mine only those it leads to", async () => {
    const store = newStore();
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const incomplete = object({ image: { $link: linkOf(utf8("held nowhere")) } });
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    await store.write({ mine: [note], blobs: [image, stray, incomplete.bytes, anything.bytes, ...signatureSchemas] });
    expect(await store.get(linkOf(image))).toEqual(image);
    for (const link of [linkOf(stray), incomplete.link, ...signatureSchemas.map(linkOf)])
      expect(await store.get(link)).toBeUndefined();
    await store.write({ blobs: [image, stray] });
    expect(await store.get(linkOf(stray))).toBeUndefined();
  });

  it("lists an object once, however many times it is written", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write({ mine: [note, note], blobs: [anything.bytes] });
    await store.write({ mine: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("lists an object that came in with another once it is written as mine", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const record = object({ received: { $link: note.link } });
    await store.write({ mine: [record], blobs: [note.bytes, anything.bytes] });
    expect(await listed(store)).toEqual([record.link]);
    await store.write({ mine: [note] });
    expect((await listed(store)).sort()).toEqual([record.link, note.link].sort());
  });

  it("refuses a batch with something written as mine that is not an object, and keeps none of it", async () => {
    const store = newStore();
    const carried = object({ text: "carried" });
    const notCanonical = utf8(` ${new TextDecoder().decode(object({ text: "hello" }).bytes)}`);
    await expect(store.write({ mine: [{ bytes: notCanonical }], blobs: [carried.bytes] })).rejects.toThrow(
      /is not an object/,
    );
    await expect(store.write({ mine: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(/is not an object/);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("refuses a batch in which a blob leads to one that neither the batch nor the store holds, and keeps none of it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const carried = object({ text: "carried" });
    await expect(store.write({ mine: [note], blobs: [carried.bytes, anything.bytes] })).rejects.toThrow(
      `${note.link} leads to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    const unheld = await encodeSchema({ $schema: DRAFT, title: "Unheld" }, defaultValidator);
    const written = encodeObject(unheld, { text: "hello" });
    await expect(store.write({ mine: [written] })).rejects.toThrow(`${written.link} leads to ${unheld.link}`);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("takes a batch whose blobs lead to blobs it holds from an earlier write", async () => {
    const store = newStore();
    const image = utf8("an image");
    const first = object({ text: "first", image: { $link: linkOf(image) } });
    await store.write({ mine: [first], blobs: [image, anything.bytes] });
    const second = object({ text: "second", image: { $link: linkOf(image) } });
    await store.write({ mine: [second] });
    expect((await listed(store)).sort()).toEqual([first.link, second.link].sort());
  });

  it("takes a string that is a link as a whole as a string, and does not ask for the blob it names", async () => {
    const store = newStore();
    const commitment = object({ hash: linkOf(utf8("a secret")) });
    await store.write({ mine: [commitment], blobs: [anything.bytes] });
    expect(await listed(store)).toEqual([commitment.link]);
    expect([...(await store.closure(commitment.link)).keys()].sort()).toEqual([commitment.link, anything.link].sort());
  });

  it("puts each blob in after the blobs it leads to, so that a write cut short leaves none without them", async () => {
    let order: Link<unknown>[] = [];
    const store = newStore(
      new (class extends MemoryBackend {
        override async put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, mine: Iterable<Link<never>>): Promise<void> {
          order = [...blobs.keys()];
          await super.put(blobs, mine);
        }
      })(),
    );
    const image = utf8("an image");
    const inner = object({ image: { $link: linkOf(image) } });
    const outer = object({ inner: { $link: inner.link } });
    await store.write({ mine: [outer], blobs: [inner.bytes, image, anything.bytes] });
    expect(order).toEqual([anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const given = new Uint8Array(note.bytes);
    await store.write({ mine: [{ bytes: given }], blobs: [anything.bytes] });
    given.fill(0);
    const gotten = await store.get(note.link);
    gotten?.fill(0);
    expect(await store.get(note.link)).toEqual(note.bytes);
  });
});

describe("the closure of a blob", () => {
  it("holds the blob, the blobs it links to and theirs in turn, its schema among them", async () => {
    const store = newStore();
    const image = utf8("an image");
    const inner = object({ image: { $link: linkOf(image) } });
    const outer = object({ inner: { $link: inner.link } });
    await store.write({ mine: [outer], blobs: [inner.bytes, image, anything.bytes] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual([outer.link, inner.link, linkOf(image), anything.link].sort());
    expect(closure.get(inner.link)).toEqual(inner.bytes);
  });

  it("follows no link out of a blob that is not of the store's encoding", async () => {
    const store = newStore();
    const target = object({ text: "target" });
    const text = utf8(`see ${target.link}`);
    const indented = utf8(` ${JSON.stringify([{ $link: target.link }])}`);
    const outer = object({ text: { $link: linkOf(text) }, indented: { $link: linkOf(indented) } });
    await store.write({ mine: [outer], blobs: [text, indented, target.bytes, anything.bytes] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual([outer.link, linkOf(text), linkOf(indented), anything.link].sort());
    expect(await store.get(target.link)).toBeUndefined();
  });

  it("is refused when the backend gives other bytes under a link it leads to", async () => {
    const backend = new MemoryBackend();
    const [inner, other] = [object({ text: "inner" }), object({ text: "other" })];
    const outer = object({ inner: { $link: inner.link } });
    await newStore(backend).write({ mine: [outer, other], blobs: [inner.bytes, anything.bytes] });
    const store = newStore(giving(backend, inner.link, other.link));
    await expect(store.closure(outer.link)).rejects.toThrow(`another blob under ${inner.link}`);
  });

  it("is empty for a link the store does not hold", async () => {
    const store = newStore();
    expect((await store.closure(object({ text: "absent" }).link)).size).toBe(0);
  });
});

describe("a signature read from a store", () => {
  it("verifies with the blobs of its signed identity, which the store holds", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const signature = await signatures.actor(signer, await signatures.identities.publish(signer)).sign(note);
    await store.write({
      mine: [note, signature],
      blobs: [...signature.signedIdentity.blobs, anything.bytes, ...signatureSchemas],
    });
    const read = await signatures.read(signature.link, store);
    expect(read.object).toBe(note.link);
    expect(read.signedIdentity.identity.root.publicKey).toEqual(signer.key.publicKey);
  });

  it("is refused when the store holds another kind of object under its link", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write({ mine: [note], blobs: [anything.bytes] });
    // @ts-expect-error: refused at compile time too
    await expect(signatures.read(note.link, store)).rejects.toThrow(/is written to/);
  });

  it("fails to read when the store does not hold it", async () => {
    const store = newStore();
    const link = linkOf(utf8("absent"));
    await expect(signatures.read(link, store)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
