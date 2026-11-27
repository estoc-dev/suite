import { ed25519 } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { type Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { acknowledgementSchema, acknowledgements } from "../src/index.ts";
import { actorOf, dataOf, memoryStore, signatures, signer, unverifiedSignatureOver } from "./fixtures.ts";

const noteSchema = schema("Note", { text: string() });
const acceptance = encodeObject(noteSchema, { text: "an acceptance" });
const acknowledgement = encodeObject(acknowledgementSchema, { acceptance: new LinkValue(acceptance.link), at: 5_000 });
const misfit = objectFormat.encode(new ObjectValue(acknowledgementSchema.link, { at: 5_000 }));
const signedBlobs = [
  acceptance.bytes,
  acknowledgement.bytes,
  misfit,
  ...noteSchema.blobs,
  ...acknowledgementSchema.blobs,
  ...signatures.schema.blobs,
];

interface HeldSignature {
  readonly link: Link<unknown>;
  readonly blobs: readonly Uint8Array[];
}

/** A store that holds every Signature given, and records a Written Object of each of `recorded`. */
async function storeRecording(
  recorded: readonly HeldSignature[],
  unrecorded: readonly HeldSignature[] = [],
): Promise<Store> {
  const store = memoryStore();
  const all = [...recorded, ...unrecorded];
  await store.write({
    roots: all.map(({ link }) => link),
    blobs: [...all.flatMap(({ blobs }) => blobs), ...signedBlobs],
  });
  await store.record(
    writtenObjectsOf(
      recorded.map(({ link }) => link),
      1,
    ),
  );
  return store;
}

async function scanOf(store: Store) {
  const rows = await store.scan(acknowledgements);
  return { data: await dataOf(rows), failedItems: rows.failures.map(({ item }) => item) };
}

describe("the acknowledgements", () => {
  it("hold the acceptance and the Signature of an Acknowledgement that was signed and recorded, and none of a Signature recorded over anything else", async () => {
    const actor = await actorOf(signer(ed25519, 51));
    const [acknowledgementSignature, noteSignature] = [await actor.sign(acknowledgement), await actor.sign(acceptance)];
    const store = await storeRecording([acknowledgementSignature, noteSignature]);
    expect(await scanOf(store)).toEqual({
      data: [
        { acceptance: new LinkValue(acceptance.link), acknowledgement: new LinkValue(acknowledgementSignature.link) },
      ],
      failedItems: [],
    });
  });

  it("hold none of a Signature over an Acknowledgement that is held and not recorded", async () => {
    const unrecordedSignature = await (await actorOf(signer(ed25519, 52))).sign(acknowledgement);
    const store = await storeRecording([], [unrecordedSignature]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [] });
  });

  it("fail on an Acknowledgement signed that does not fit its schema, and not on the Signature over it", async () => {
    const misfitSignature = await (await actorOf(signer(ed25519, 53))).sign({ link: linkOf(misfit) });
    const store = await storeRecording([misfitSignature]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });

  it("fail on a Signature recorded over an Acknowledgement that does not verify", async () => {
    const unverifiedSignature = await unverifiedSignatureOver(acknowledgement.link, signer(ed25519, 54));
    const store = await storeRecording([unverifiedSignature]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [unverifiedSignature.link] });
  });

  it("do not fail on a Signature recorded over what is not an Acknowledgement that would not verify", async () => {
    const unverifiedSignature = await unverifiedSignatureOver(acceptance.link, signer(ed25519, 55));
    const store = await storeRecording([unverifiedSignature]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [] });
  });
});
