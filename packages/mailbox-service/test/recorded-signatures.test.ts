import { signatureSchema } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { type Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { recordedSignatures } from "../src/index.ts";
import { dataOf, memoryStore } from "./fixtures.ts";

const noteSchema = schema("Note", { text: string() });
const note = encodeObject(noteSchema, { text: "signed" });
const signer = encodeObject(noteSchema, { text: "signer" });
const signature = encodeObject(signatureSchema, {
  signedIdentity: new LinkValue(signer.link),
  object: new LinkValue(note.link as Link<never>),
  signature: new Uint8Array(64),
});
const blobs = [signature.bytes, note.bytes, signer.bytes, ...signatureSchema.blobs, ...noteSchema.blobs];

async function storeHolding(more: readonly Uint8Array[] = []): Promise<Store> {
  const store = memoryStore();
  await store.write({ roots: [signature.link, ...more.map(linkOf)], blobs: [...blobs, ...more] });
  return store;
}

describe("the recorded signatures", () => {
  it("are those that a Written Object among the records links to, each once however often it was written", async () => {
    const store = await storeHolding();
    await store.record(writtenObjectsOf([signature.link], 1));
    await store.record(writtenObjectsOf([signature.link], 2));
    const rows = await store.scan(recordedSignatures);
    expect(await dataOf(rows)).toEqual([
      { object: new LinkValue(note.link), signature: new LinkValue(signature.link) },
    ]);
    expect(rows.failures).toEqual([]);
  });

  it("are none of a signature that is held and not recorded", async () => {
    const store = await storeHolding();
    await store.record(writtenObjectsOf([note.link], 1));
    expect(await dataOf(await store.scan(recordedSignatures))).toEqual([]);
  });

  it("are none of what was written that is not a Signature, and that is no failure", async () => {
    const image = new TextEncoder().encode("an image");
    const store = await storeHolding([image]);
    await store.record(writtenObjectsOf([note.link, linkOf(image)], 1));
    const rows = await store.scan(recordedSignatures);
    expect(await dataOf(rows)).toEqual([]);
    expect(rows.failures).toEqual([]);
  });

  it("fail on a Signature written that does not fit its schema, and not on the Written Object that links to it", async () => {
    const misfit = objectFormat.encode(new ObjectValue(signatureSchema.link, { object: 1 }));
    const store = await storeHolding([misfit]);
    await store.record(writtenObjectsOf([signature.link, linkOf(misfit)], 1));
    const rows = await store.scan(recordedSignatures);
    expect(await dataOf(rows)).toHaveLength(1);
    expect(rows.failures.map(({ item }) => item)).toEqual([linkOf(misfit)]);
  });
});
