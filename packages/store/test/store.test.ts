import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import { digestOf, encodeObject, type Link, LinkValue, linkOf } from "@estoc/object";
import { array, type DataOf, link, optional, rootSchema, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { type Backend, type Batch, MemoryBackend, RefusedBatch, Store } from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  text: optional(string()),
  hash: optional(string()),
  image: optional(link()),
  inner: optional(link()),
  received: optional(link()),
  attachments: optional(array(link())),
});
const { identities, signatures, publish } = loadIdentity([ed25519]);
const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(7));
const signatureSchemas = [signatures.schema, identities.encode(signer.key, { at: 0 }).schema].map(({ bytes }) => bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);

/** The batch that keeps `objects`, with those of `blobs` in their closures. */
const batchOf = (
  objects: readonly { readonly link: Link<unknown>; readonly bytes: Uint8Array }[],
  blobs: Iterable<Uint8Array> = [],
): Batch => ({ roots: objects.map(({ link }) => link), blobs: [...objects.map(({ bytes }) => bytes), ...blobs] });

const newStore = (backend: Backend = new MemoryBackend()) => new Store(backend);

const backendGiving = (backend: Backend, under: Link<unknown>, other: Link<unknown>): Backend => ({
  get: (link) => backend.get(link === under ? other : link),
  has: (link) => backend.has(link),
  put: (blobs, listedLinks) => backend.put(blobs, listedLinks),
  listedLinks: (start) => backend.listedLinks(start),
  blobs: (start) => backend.blobs(start),
});

async function blobsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.blobs()) links.push(link);
  return links;
}

describe("a store", () => {
  it("gives a blob back by its link, and nothing for a link it does not hold", async () => {
    const store = newStore();
    const image = utf8("not an object");
    await store.write(batchOf([object({ image: new LinkValue(linkOf(image)) })], [image, ...anything.blobs]));
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("refuses to give a blob when its backend gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [keptObject, other] = [object({ text: "kept" }), object({ text: "other" })];
    await newStore(backend).write(batchOf([keptObject, other], anything.blobs));
    const store = newStore(backendGiving(backend, keptObject.link, other.link));
    await expect(store.get(keptObject.link)).rejects.toThrow(`another blob under ${keptObject.link}`);
  });

  it("keeps of the blobs of a batch only those in the closures of its roots", async () => {
    const store = newStore();
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const incomplete = object({ image: new LinkValue(linkOf(utf8("held nowhere"))) });
    const note = object({ text: "hello", image: new LinkValue(linkOf(image)) });
    await store.write(batchOf([note], [image, stray, incomplete.bytes, ...anything.blobs, ...signatureSchemas]));
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
    for (const link of [linkOf(stray), incomplete.link, ...signatureSchemas.map(linkOf)])
      expect(await store.get(link)).toBeUndefined();
    await store.write({ roots: [], blobs: [image, stray] });
    expect(await store.get(linkOf(stray))).toBeUndefined();
  });

  it("gives its backend no links to list", async () => {
    const backend = new MemoryBackend();
    await newStore(backend).write(batchOf([object({ text: "hello" })], anything.blobs));
    const listedLinks: Link<unknown>[] = [];
    for await (const link of backend.listedLinks()) listedLinks.push(link);
    expect(listedLinks).toEqual([]);
  });

  it("takes a root that is not an object", async () => {
    const store = newStore();
    const image = utf8("an image");
    await store.write({ roots: [linkOf(image)], blobs: [image] });
    expect(await store.get(linkOf(image))).toEqual(image);
  });

  it("takes a root that it holds already, which the batch need not give", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write(batchOf([note], anything.blobs));
    const reply = object({ inner: new LinkValue(note.link) });
    await store.write({ roots: [note.link, reply.link], blobs: [reply.bytes] });
    expect(await store.get(reply.link)).toEqual(reply.bytes);
  });

  it("refuses a root that neither the batch nor it holds, and keeps none of the batch", async () => {
    const store = newStore();
    const [note, other] = [object({ text: "hello" }), object({ text: "not given" })];
    const batch = { roots: [note.link, other.link], blobs: [note.bytes, ...anything.blobs] };
    await expect(store.write(batch)).rejects.toThrow(
      `neither the batch nor the store holds ${other.link}, which the batch is to keep`,
    );
    expect(await blobsOf(store)).toEqual([]);
  });

  it("refuses a batch in which a blob links to one that neither the batch nor the store holds, and keeps none of it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: new LinkValue(linkOf(image)) });
    const carriedObject = object({ text: "carried" });
    await expect(store.write(batchOf([note], [carriedObject.bytes, ...anything.blobs]))).rejects.toThrow(
      `${note.link} links to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    const unheldSchema = schema("Unheld", { text: string() });
    const writtenObject = encodeObject(unheldSchema, { text: "hello" });
    await expect(store.write(batchOf([writtenObject]))).rejects.toThrow(
      `${writtenObject.link} links to ${unheldSchema.link}`,
    );
    expect(await blobsOf(store)).toEqual([]);
  });

  it("refuses a batch for what it is with a RefusedBatch, and passes on a backend's own failure as it is", async () => {
    const image = utf8("an image");
    const note = object({ text: "hello", image: new LinkValue(linkOf(image)) });
    const store = newStore();
    await expect(store.write(batchOf([note], anything.blobs))).rejects.toThrow(RefusedBatch);
    await expect(store.write({ roots: [note.link], blobs: [] })).rejects.toThrow(RefusedBatch);

    const diskError = new Error("the disk is gone");
    const backend = new MemoryBackend();
    const failingStore = newStore({
      get: (link) => backend.get(link),
      has: () => Promise.reject(diskError),
      put: () => Promise.reject(diskError),
      listedLinks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
    await expect(failingStore.write(batchOf([note], anything.blobs))).rejects.toBe(diskError);
    await expect(failingStore.write(batchOf([note], [image, ...anything.blobs]))).rejects.toBe(diskError);
  });

  it("takes a batch whose blobs link to blobs it holds from an earlier write", async () => {
    const store = newStore();
    const image = utf8("an image");
    const first = object({ text: "first", image: new LinkValue(linkOf(image)) });
    await store.write(batchOf([first], [image, ...anything.blobs]));
    const second = object({ text: "second", image: new LinkValue(linkOf(image)) });
    await store.write(batchOf([second]));
    expect(await store.get(second.link)).toEqual(second.bytes);
  });

  it("takes a string that is a link as a whole as a string, and does not ask for the blob it names", async () => {
    const store = newStore();
    const commitment = object({ hash: linkOf(utf8("a secret")) });
    await store.write(batchOf([commitment], anything.blobs));
    expect([...(await store.closure(commitment.link)).keys()].sort()).toEqual(
      [commitment.link, anything.link, rootSchema.link].sort(),
    );
  });

  it("puts each blob in after the blobs it links to, so that a write cut short leaves none without its closure", async () => {
    let order: Link<unknown>[] = [];
    const store = newStore(
      new (class extends MemoryBackend {
        override async put(
          blobs: ReadonlyMap<Link<unknown>, Uint8Array>,
          listedLinks: Iterable<Link<never>>,
        ): Promise<void> {
          order = [...blobs.keys()];
          await super.put(blobs, listedLinks);
        }
      })(),
    );
    const image = utf8("an image");
    const inner = object({ image: new LinkValue(linkOf(image)) });
    const outer = object({ inner: new LinkValue(inner.link) });
    await store.write(batchOf([outer], [inner.bytes, image, ...anything.blobs]));
    expect(order).toEqual([rootSchema.link, anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("lists each blob after the blobs it links to, and where it was when the blob is written again", async () => {
    const store = newStore();
    const image = utf8("an image");
    const inner = object({ image: new LinkValue(linkOf(image)) });
    const outer = object({ inner: new LinkValue(inner.link) });
    await store.write(batchOf([inner], [image, ...anything.blobs]));
    await store.write(batchOf([outer, inner], [image]));
    expect(await blobsOf(store)).toEqual([rootSchema.link, anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("lists the blobs it holds, each once", async () => {
    const store = newStore();
    expect(await blobsOf(store)).toEqual([]);
    const image = utf8("an image");
    const inner = object({ image: new LinkValue(linkOf(image)) });
    const outer = object({ inner: new LinkValue(inner.link) });
    await store.write(batchOf([outer], [inner.bytes, image, ...anything.blobs]));
    await store.write(batchOf([outer], [inner.bytes, image]));
    expect(await blobsOf(store)).toEqual([rootSchema.link, anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("lists among its blobs none that a write dropped or refused", async () => {
    const store = newStore();
    const stray = utf8("led to by nothing written");
    const note = object({ text: "hello" });
    await store.write(batchOf([note], [stray, ...anything.blobs]));
    const incomplete = object({ image: new LinkValue(linkOf(utf8("held nowhere"))) });
    await expect(store.write(batchOf([incomplete], [stray]))).rejects.toThrow(RefusedBatch);
    expect(await blobsOf(store)).toEqual([rootSchema.link, anything.link, note.link]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const givenBytes = new Uint8Array(note.bytes);
    await store.write({ roots: [note.link], blobs: [givenBytes, ...anything.blobs] });
    givenBytes.fill(0);
    const gottenBytes = await store.get(note.link);
    gottenBytes?.fill(0);
    expect(await store.get(note.link)).toEqual(note.bytes);
  });
});

describe("the closure of a blob", () => {
  it("holds the blob, the blobs it links to and theirs in turn, its schema and the root schema among them", async () => {
    const store = newStore();
    const image = utf8("an image");
    const inner = object({ image: new LinkValue(linkOf(image)) });
    const outer = object({ inner: new LinkValue(inner.link) });
    await store.write(batchOf([outer], [inner.bytes, image, ...anything.blobs]));
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, inner.link, linkOf(image), anything.link, rootSchema.link].sort(),
    );
    expect(closure.get(inner.link)).toEqual(inner.bytes);
  });

  it("follows no link out of a blob that is not an object", async () => {
    const store = newStore();
    const target = object({ text: "target" });
    const linkUnderItsTag = Uint8Array.of(0xd9, 0x48, 0x6c, 0x58, 0x20, ...digestOf(target.link));
    const bytes = [
      utf8(`see ${target.link}`),
      linkUnderItsTag,
      Uint8Array.of(0x81, ...linkUnderItsTag),
      Uint8Array.of(...object({ received: new LinkValue(target.link) }).bytes, 0),
    ];
    const outer = object({ attachments: bytes.map((blob) => new LinkValue(linkOf(blob))) });
    await store.write(batchOf([outer], [...bytes, target.bytes, ...anything.blobs]));
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, ...bytes.map((blob) => linkOf(blob)), anything.link, rootSchema.link].sort(),
    );
    expect(await store.get(target.link)).toBeUndefined();
  });

  it("is refused when the backend gives other bytes under a link in it", async () => {
    const backend = new MemoryBackend();
    const [inner, other] = [object({ text: "inner" }), object({ text: "other" })];
    const outer = object({ inner: new LinkValue(inner.link) });
    await newStore(backend).write(batchOf([outer, other], [inner.bytes, ...anything.blobs]));
    const store = newStore(backendGiving(backend, inner.link, other.link));
    await expect(store.closure(outer.link)).rejects.toThrow(`another blob under ${inner.link}`);
  });

  it("is refused when the backend no longer gives a blob in it", async () => {
    const backend = new MemoryBackend();
    const [inner, absent] = [object({ text: "inner" }), object({ text: "absent" })];
    const outer = object({ inner: new LinkValue(inner.link) });
    await newStore(backend).write(batchOf([outer], [inner.bytes, ...anything.blobs]));
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
    await store.write(
      batchOf([note, signature], [...signature.signedIdentity.blobs, ...anything.blobs, ...signatureSchemas]),
    );
    const readSignature = await signatures.read(signature.link, store, noIdentityVersions);
    expect(readSignature.object).toBe(note.link);
    expect(readSignature.signedIdentity.identity.root.publicKey).toEqual(signer.key.publicKey);
  });

  it("is refused when the store holds another kind of object under its link", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write(batchOf([note], anything.blobs));
    // @ts-expect-error: refused at compile time too
    await expect(signatures.read(note.link, store, noIdentityVersions)).rejects.toThrow(/is written to/);
  });

  it("fails to read when the store does not hold it", async () => {
    const store = newStore();
    const link = linkOf(utf8("absent"));
    await expect(signatures.read(link, store, noIdentityVersions)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
