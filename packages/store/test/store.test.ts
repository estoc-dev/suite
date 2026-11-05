import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type JsonObject, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Backend, MemoryBackend, RefusedBatch, Store } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const { identities, signatures, publish } = await loadIdentity(defaultValidator);
const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(7));
const signatureSchemas = [signatures.schema, identities.encode(signer.key, 0).schema].map(({ bytes }) => bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);

const newStore = (backend: Backend = new MemoryBackend()) => new Store(json, backend);

const giving = (backend: Backend, under: Link<unknown>, other: Link<unknown>): Backend => ({
  get: (link) => backend.get(link === under ? other : link),
  has: (link) => backend.has(link),
  put: (blobs, records) => backend.put(blobs, records),
  records: () => backend.records(),
});

async function listed(store: Store): Promise<Link<unknown>[]> {
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
      blobs: [image, anything.bytes, anything.root.bytes],
    });
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(linkOf(utf8("never written")))).toBeUndefined();
  });

  it("refuses to give a blob when its backend gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [kept, other] = [object({ text: "kept" }), object({ text: "other" })];
    await newStore(backend).write({ records: [kept, other], blobs: [anything.bytes, anything.root.bytes] });
    const store = newStore(giving(backend, kept.link, other.link));
    await expect(store.get(kept.link)).rejects.toThrow(`another blob under ${kept.link}`);
  });

  it("lists its records, and not the blobs written with them", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    await store.write({ records: [note], blobs: [image, anything.bytes, anything.root.bytes] });
    expect(await listed(store)).toEqual([note.link]);
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
      blobs: [image, stray, incomplete.bytes, anything.bytes, anything.root.bytes, ...signatureSchemas],
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
    await store.write({ records: [note, note], blobs: [anything.bytes, anything.root.bytes] });
    await store.write({ records: [note] });
    expect(await listed(store)).toEqual([note.link]);
  });

  it("lists an object that came in with another once it is written as a record", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const record = object({ received: { $link: note.link } });
    await store.write({ records: [record], blobs: [note.bytes, anything.bytes, anything.root.bytes] });
    expect(await listed(store)).toEqual([record.link]);
    await store.write({ records: [note] });
    expect((await listed(store)).sort()).toEqual([record.link, note.link].sort());
  });

  it("refuses a batch with a record that is not an object, and keeps none of it", async () => {
    const store = newStore();
    const carried = object({ text: "carried" });
    const notCanonical = utf8(` ${new TextDecoder().decode(object({ text: "hello" }).bytes)}`);
    await expect(store.write({ records: [{ bytes: notCanonical }], blobs: [carried.bytes] })).rejects.toThrow(
      /is not an object/,
    );
    await expect(store.write({ records: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(/is not an object/);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("refuses a batch in which a blob links to one that neither the batch nor the store holds, and keeps none of it", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const carried = object({ text: "carried" });
    await expect(
      store.write({ records: [note], blobs: [carried.bytes, anything.bytes, anything.root.bytes] }),
    ).rejects.toThrow(`${note.link} links to ${linkOf(image)}, which neither the batch nor the store holds`);
    const unheld = await encodeSchema({ $schema: DRAFT, title: "Unheld" }, defaultValidator);
    const written = encodeObject(unheld, { text: "hello" });
    await expect(store.write({ records: [written] })).rejects.toThrow(`${written.link} links to ${unheld.link}`);
    expect(await store.get(carried.link)).toBeUndefined();
    expect(await listed(store)).toEqual([]);
  });

  it("refuses a batch for what it is with a RefusedBatch, and passes on a backend's own failure as it is", async () => {
    const image = utf8("an image");
    const note = object({ text: "hello", image: { $link: linkOf(image) } });
    const store = newStore();
    await expect(store.write({ records: [note], blobs: [anything.bytes, anything.root.bytes] })).rejects.toThrow(
      RefusedBatch,
    );
    await expect(store.write({ records: [{ bytes: json.encode([1, 2]) }] })).rejects.toThrow(RefusedBatch);

    const gone = new Error("the disk is gone");
    const backend = new MemoryBackend();
    const failing = newStore({
      get: (link) => backend.get(link),
      has: () => Promise.reject(gone),
      put: () => Promise.reject(gone),
      records: () => backend.records(),
    });
    await expect(failing.write({ records: [note], blobs: [anything.bytes, anything.root.bytes] })).rejects.toBe(gone);
    await expect(failing.write({ records: [note], blobs: [image, anything.bytes, anything.root.bytes] })).rejects.toBe(
      gone,
    );
  });

  it("takes a batch whose blobs link to blobs it holds from an earlier write", async () => {
    const store = newStore();
    const image = utf8("an image");
    const first = object({ text: "first", image: { $link: linkOf(image) } });
    await store.write({ records: [first], blobs: [image, anything.bytes, anything.root.bytes] });
    const second = object({ text: "second", image: { $link: linkOf(image) } });
    await store.write({ records: [second] });
    expect((await listed(store)).sort()).toEqual([first.link, second.link].sort());
  });

  it("takes a string that is a link as a whole as a string, and does not ask for the blob it names", async () => {
    const store = newStore();
    const commitment = object({ hash: linkOf(utf8("a secret")) });
    await store.write({ records: [commitment], blobs: [anything.bytes, anything.root.bytes] });
    expect(await listed(store)).toEqual([commitment.link]);
    expect([...(await store.closure(commitment.link)).keys()].sort()).toEqual(
      [commitment.link, anything.link, anything.root.link].sort(),
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
    await store.write({ records: [outer], blobs: [inner.bytes, image, anything.bytes, anything.root.bytes] });
    expect(order).toEqual([anything.root.link, anything.link, linkOf(image), inner.link, outer.link]);
  });

  it("keeps what was written, whatever happens afterwards to the arrays it was given or gave out", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const given = new Uint8Array(note.bytes);
    await store.write({ records: [{ bytes: given }], blobs: [anything.bytes, anything.root.bytes] });
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
    await store.write({ records: [outer], blobs: [inner.bytes, image, anything.bytes, anything.root.bytes] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, inner.link, linkOf(image), anything.link, anything.root.link].sort(),
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
    await store.write({ records: [outer], blobs: [...bytes, target.bytes, anything.bytes, anything.root.bytes] });
    const closure = await store.closure(outer.link);
    expect([...closure.keys()].sort()).toEqual(
      [outer.link, ...bytes.map((blob) => linkOf(blob)), anything.link, anything.root.link].sort(),
    );
    expect(await store.get(target.link)).toBeUndefined();
  });

  it("is refused when the backend gives other bytes under a link in it", async () => {
    const backend = new MemoryBackend();
    const [inner, other] = [object({ text: "inner" }), object({ text: "other" })];
    const outer = object({ inner: { $link: inner.link } });
    await newStore(backend).write({
      records: [outer, other],
      blobs: [inner.bytes, anything.bytes, anything.root.bytes],
    });
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
    const signature = await signatures.actor(signer, await publish(signer, 0)).sign(note);
    await store.write({
      records: [note, signature],
      blobs: [...signature.signedIdentity.blobs, anything.bytes, anything.root.bytes, ...signatureSchemas],
    });
    const read = await signatures.read(signature.link, store, noVersions);
    expect(read.object).toBe(note.link);
    expect(read.signedIdentity.identity.root.publicKey).toEqual(signer.key.publicKey);
  });

  it("is refused when the store holds another kind of object under its link", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    await store.write({ records: [note], blobs: [anything.bytes, anything.root.bytes] });
    // @ts-expect-error: refused at compile time too
    await expect(signatures.read(note.link, store, noVersions)).rejects.toThrow(/is written to/);
  });

  it("fails to read when the store does not hold it", async () => {
    const store = newStore();
    const link = linkOf(utf8("absent"));
    await expect(signatures.read(link, store, noVersions)).rejects.toThrow(`no blob is given for ${link}`);
  });
});
