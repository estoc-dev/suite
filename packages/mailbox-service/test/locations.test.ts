import { ed25519 } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import type { Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { locations, serviceSchema } from "../src/index.ts";
import { actorOf, dataOf, memoryStore, signatures, signer, unverifiedSignatureOver } from "./fixtures.ts";

const noteSchema = schema("Note", { text: string() });
const note = encodeObject(noteSchema, { text: "signed" });
const service = encodeObject(serviceSchema, { origin: "https://mail.example", at: 5_000, offers: [] });
const misfit = objectFormat.encode(new ObjectValue(serviceSchema.link, { at: "soon" }));
const signedBlobs = [note.bytes, service.bytes, misfit, ...noteSchema.blobs, ...serviceSchema.blobs];

async function storeHolding(roots: readonly Link<unknown>[], blobs: readonly Uint8Array[]): Promise<Store> {
  const store = memoryStore();
  await store.write({ roots, blobs: [...blobs, ...signedBlobs, ...signatures.schema.blobs] });
  return store;
}

async function scanOf(store: Store) {
  const rows = await store.scan(locations);
  return { data: await dataOf(rows), failedItems: rows.failures.map(({ item }) => item) };
}

describe("the locations", () => {
  it("hold the identifier that signed a Service, its at and the Signature, and none of a Signature over anything else", async () => {
    const actor = await actorOf(signer(ed25519, 41));
    const [serviceSignature, noteSignature] = [await actor.sign(service), await actor.sign(note)];
    const store = await storeHolding(
      [serviceSignature.link, noteSignature.link],
      [...serviceSignature.blobs, ...noteSignature.blobs],
    );
    expect(await scanOf(store)).toEqual({
      data: [{ identifier: new LinkValue(actor.identifier), at: 5_000, service: new LinkValue(serviceSignature.link) }],
      failedItems: [],
    });
  });

  it("fail on a Service signed that does not fit its schema, and not on the Signature over it", async () => {
    const misfitSignature = await (await actorOf(signer(ed25519, 42))).sign({ link: linkOf(misfit) });
    const store = await storeHolding([misfitSignature.link], misfitSignature.blobs);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });

  it("fail on a Signature over a Service that does not verify", async () => {
    const unverifiedSignature = await unverifiedSignatureOver(service.link, signer(ed25519, 43));
    const store = await storeHolding([unverifiedSignature.link], unverifiedSignature.blobs);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [unverifiedSignature.link] });
  });

  it("do not fail on a Signature over what is not a Service that would not verify", async () => {
    const unverifiedSignature = await unverifiedSignatureOver(note.link, signer(ed25519, 44));
    const store = await storeHolding([unverifiedSignature.link], unverifiedSignature.blobs);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [] });
  });
});
