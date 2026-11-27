import { ed25519 } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import type { Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { locations, serviceSchema } from "../src/index.ts";
import { actorOf, dataOf, memoryStore, signatures, signer } from "./fixtures.ts";

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
    const [overService, overNote] = [await actor.sign(service), await actor.sign(note)];
    const store = await storeHolding([overService.link, overNote.link], [...overService.blobs, ...overNote.blobs]);
    expect(await scanOf(store)).toEqual({
      data: [{ identifier: new LinkValue(actor.identifier), at: 5_000, service: new LinkValue(overService.link) }],
      failedItems: [],
    });
  });

  it("fail on a Service signed that does not fit its schema, and not on the Signature over it", async () => {
    const overMisfit = await (await actorOf(signer(ed25519, 42))).sign({ link: linkOf(misfit) });
    const store = await storeHolding([overMisfit.link], overMisfit.blobs);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });

  it("fail on a Signature held that does not verify, whatever it signs", async () => {
    const overService = await (await actorOf(signer(ed25519, 43))).sign(service);
    const moved = encodeObject(signatures.schema, {
      signedIdentity: new LinkValue(overService.signedIdentity.link),
      object: new LinkValue(note.link as Link<never>),
      signature: overService.signature,
    });
    const store = await storeHolding([moved.link], [moved.bytes, ...overService.signedIdentity.blobs]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [moved.link] });
  });
});
