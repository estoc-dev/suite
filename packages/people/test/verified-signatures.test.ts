import { ed25519, type Signature } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { type Index, MemoryBackend, recordedWrittenObjects, Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { type VerifiedSignatureData, verifiedSignatures, verifiedSignaturesOver } from "../src/index.ts";
import { identityVersionInHand, publish, signatures, signer } from "./fixtures.ts";

const noteSchema = schema("Note", { text: string() });
const note = encodeObject(noteSchema, { text: "signed" });
const noteBlobs = [note.bytes, ...noteSchema.blobs];
const image = new TextEncoder().encode("an image");

async function signatureBy(fill: number, object: { readonly link: Link<unknown> }): Promise<Signature> {
  const by = signer(ed25519, fill);
  return signatures.actor(by, await publish(by, { at: 1_000 }), identityVersionInHand).sign(object);
}

const rowOf = ({ link, signedIdentity, object }: Signature): VerifiedSignatureData => ({
  identifier: new LinkValue(signedIdentity.identity.identifier),
  signature: new LinkValue(link),
  object: new LinkValue(object),
});

async function storeHolding(roots: readonly Link<unknown>[], blobs: readonly Uint8Array[]): Promise<Store> {
  const store = new Store(new MemoryBackend());
  await store.write({ roots, blobs: [...blobs, ...noteBlobs, image, ...signatures.schema.blobs] });
  return store;
}

async function scanOf(store: Store, index: Index<VerifiedSignatureData>) {
  const rows = await store.scan(index);
  const data: VerifiedSignatureData[] = [];
  for await (const row of rows) data.push(row.data);
  return { data, failedItems: rows.failures.map(({ item }) => item) };
}

describe("the verified signatures", () => {
  it("hold the identifier that signed, the Signature and what it signs, of each Signature held, whatever it signs", async () => {
    const overNote = await signatureBy(31, note);
    const overImage = await signatureBy(32, { link: linkOf(image) });
    const store = await storeHolding([overNote.link, overImage.link], [...overNote.blobs, ...overImage.blobs]);
    const { data, failedItems } = await scanOf(store, verifiedSignatures);
    expect(data).toHaveLength(2);
    expect(data).toEqual(expect.arrayContaining([rowOf(overNote), rowOf(overImage)]));
    expect(failedItems).toEqual([]);
  });

  it("hold none of a Signature that the identity version it carries does not verify, and fail on it", async () => {
    const overImage = await signatureBy(33, { link: linkOf(image) });
    const moved = encodeObject(signatures.schema, {
      signedIdentity: new LinkValue(overImage.signedIdentity.link),
      object: new LinkValue(note.link as Link<never>),
      signature: overImage.signature,
    });
    const store = await storeHolding([moved.link], [moved.bytes, ...overImage.signedIdentity.blobs]);
    expect(await scanOf(store, verifiedSignatures)).toEqual({ data: [], failedItems: [moved.link] });
  });

  it("fail on a Signature that does not fit its schema", async () => {
    const misfit = objectFormat.encode(new ObjectValue(signatures.schema.link, { object: 1 }));
    const store = await storeHolding([linkOf(misfit)], [misfit]);
    expect(await scanOf(store, verifiedSignatures)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });
});

describe("the verified signatures over a source", () => {
  const writtenSignatures = verifiedSignaturesOver(recordedWrittenObjects.linksAt("object"));

  it("are those among the blobs that the source gives, and none of one that is held and not given", async () => {
    const written = await signatureBy(34, note);
    const held = await signatureBy(35, note);
    const store = await storeHolding([written.link, held.link], [...written.blobs, ...held.blobs]);
    await store.record(writtenObjectsOf([written.link], 1));
    expect(await scanOf(store, writtenSignatures)).toEqual({ data: [rowOf(written)], failedItems: [] });
  });

  it("are none of what the source gives that is not a Signature, and that is no failure", async () => {
    const written = await signatureBy(36, note);
    const store = await storeHolding([written.link, linkOf(image)], written.blobs);
    await store.record(writtenObjectsOf([note.link, linkOf(image), written.link], 1));
    expect(await scanOf(store, writtenSignatures)).toEqual({ data: [rowOf(written)], failedItems: [] });
  });
});
