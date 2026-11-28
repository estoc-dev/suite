import { ed25519, type Signature } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { heldBlobs, type Index, MemoryBackend, recordedWrittenObjects, Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { type VerifiedSignatureData, verifiedSignaturesOf, verifiedSignaturesOver } from "../src/index.ts";
import { identityVersionInHand, publish, signatures, signer } from "./fixtures.ts";

const noteSchema = schema("Note", { text: string() });
const note = encodeObject(noteSchema, { text: "signed" });
const image = new TextEncoder().encode("an image");
const cardSchema = schema("Card", { name: string() });
const card = encodeObject(cardSchema, { name: "signed" });
const signedBlobs = [note.bytes, card.bytes, image, ...noteSchema.blobs, ...cardSchema.blobs];

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
  await store.write({ roots, blobs: [...blobs, ...signedBlobs, ...signatures.schema.blobs] });
  return store;
}

/** A Signature that holds what `signature` holds and signs `object`, which the identity version it carries does not verify. */
const retargeted = ({ signedIdentity, signature }: Signature, object: Link<unknown>) =>
  encodeObject(signatures.schema, {
    signedIdentity: new LinkValue(signedIdentity.link),
    object: new LinkValue(object as Link<never>),
    signature,
  });

async function scanOf(store: Store, index: Index<VerifiedSignatureData>) {
  const rows = await store.scan(index);
  const data: VerifiedSignatureData[] = [];
  for await (const row of rows) data.push(row.data);
  return { data, failedItems: rows.failures.map(({ item }) => item) };
}

describe("the verified signatures over a collection", () => {
  const recordedSignatures = verifiedSignaturesOver(recordedWrittenObjects.linksAt("object"));

  it("hold the identifier that signed, the Signature and what it signs, of each Signature given, whatever it signs", async () => {
    const noteSignature = await signatureBy(31, note);
    const imageSignature = await signatureBy(32, { link: linkOf(image) });
    const store = await storeHolding(
      [noteSignature.link, imageSignature.link],
      [...noteSignature.blobs, ...imageSignature.blobs],
    );
    await store.record(writtenObjectsOf([noteSignature.link, imageSignature.link], 1));
    const { data, failedItems } = await scanOf(store, recordedSignatures);
    expect(data).toHaveLength(2);
    expect(data).toEqual(expect.arrayContaining([rowOf(noteSignature), rowOf(imageSignature)]));
    expect(failedItems).toEqual([]);
  });

  it("hold none of a Signature that is held and not given", async () => {
    const recordedSignature = await signatureBy(34, note);
    const unrecordedSignature = await signatureBy(35, note);
    const store = await storeHolding(
      [recordedSignature.link, unrecordedSignature.link],
      [...recordedSignature.blobs, ...unrecordedSignature.blobs],
    );
    await store.record(writtenObjectsOf([recordedSignature.link], 1));
    expect(await scanOf(store, recordedSignatures)).toEqual({ data: [rowOf(recordedSignature)], failedItems: [] });
  });

  it("hold none of what the collection gives that is not a Signature, and that is no failure", async () => {
    const recordedSignature = await signatureBy(36, note);
    const store = await storeHolding([recordedSignature.link, linkOf(image)], recordedSignature.blobs);
    await store.record(writtenObjectsOf([note.link, linkOf(image), recordedSignature.link], 1));
    expect(await scanOf(store, recordedSignatures)).toEqual({ data: [rowOf(recordedSignature)], failedItems: [] });
  });

  it("hold none of a Signature that the identity version it carries does not verify, and fail on it", async () => {
    const imageSignature = await signatureBy(33, { link: linkOf(image) });
    const retargetedSignature = retargeted(imageSignature, note.link);
    const store = await storeHolding(
      [retargetedSignature.link],
      [retargetedSignature.bytes, ...imageSignature.signedIdentity.blobs],
    );
    await store.record(writtenObjectsOf([retargetedSignature.link], 1));
    expect(await scanOf(store, recordedSignatures)).toEqual({ data: [], failedItems: [retargetedSignature.link] });
  });
});

describe("the verified signatures of a schema", () => {
  const noteSignatures = verifiedSignaturesOf(noteSchema, heldBlobs);

  it("hold the row of each Signature held that signs an object that names the schema", async () => {
    const noteSignature = await signatureBy(37, note);
    const cardSignature = await signatureBy(37, card);
    const imageSignature = await signatureBy(37, { link: linkOf(image) });
    const store = await storeHolding(
      [noteSignature.link, cardSignature.link, imageSignature.link],
      [...noteSignature.blobs, ...cardSignature.blobs, ...imageSignature.blobs],
    );
    expect(await scanOf(store, noteSignatures)).toEqual({ data: [rowOf(noteSignature)], failedItems: [] });
  });

  it("hold none of a Signature over such an object that is held and that the collection does not give", async () => {
    const recordedSignature = await signatureBy(40, note);
    const unrecordedSignature = await signatureBy(41, note);
    const store = await storeHolding(
      [recordedSignature.link, unrecordedSignature.link],
      [...recordedSignature.blobs, ...unrecordedSignature.blobs],
    );
    await store.record(writtenObjectsOf([recordedSignature.link], 1));
    const recordedNoteSignatures = verifiedSignaturesOf(noteSchema, recordedWrittenObjects.linksAt("object"));
    expect(await scanOf(store, recordedNoteSignatures)).toEqual({ data: [rowOf(recordedSignature)], failedItems: [] });
  });

  it("fail on a Signature over such an object that does not verify", async () => {
    const cardSignature = await signatureBy(38, card);
    const retargetedSignature = retargeted(cardSignature, note.link);
    const store = await storeHolding(
      [retargetedSignature.link],
      [retargetedSignature.bytes, ...cardSignature.signedIdentity.blobs],
    );
    expect(await scanOf(store, noteSignatures)).toEqual({ data: [], failedItems: [retargetedSignature.link] });
  });

  it.each([
    ["an object of another schema", card.link],
    ["what is not an object", linkOf(image)],
  ])("do not fail on a Signature over %s that would not verify", async (_, object) => {
    const noteSignature = await signatureBy(39, note);
    const retargetedSignature = retargeted(noteSignature, object);
    const store = await storeHolding(
      [retargetedSignature.link],
      [retargetedSignature.bytes, ...noteSignature.signedIdentity.blobs],
    );
    expect(await scanOf(store, noteSignatures)).toEqual({ data: [], failedItems: [] });
  });

  it("fail on a Signature that does not fit its schema, whatever it signs", async () => {
    const misfit = objectFormat.encode(new ObjectValue(signatures.schema.link, { object: 1 }));
    const store = await storeHolding([linkOf(misfit)], [misfit]);
    expect(await scanOf(store, noteSignatures)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });
});
