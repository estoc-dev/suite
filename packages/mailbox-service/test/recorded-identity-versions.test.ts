import { ed25519 } from "@estoc/identity";
import { digestOf, type Link, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { type Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { recordedIdentityVersions } from "../src/index.ts";
import { dataOf, keys, memoryStore, publish, signedIdentities, signer } from "./fixtures.ts";

/** A store that holds the blobs under `roots`, and records a Written Object of each of `recorded`. */
async function storeRecording(
  recorded: readonly Link<unknown>[],
  roots: readonly Link<unknown>[],
  blobs: readonly Uint8Array[],
): Promise<Store> {
  const store = memoryStore();
  await store.write({ roots, blobs: [...blobs, ...signedIdentities.schema.blobs] });
  await store.record(writtenObjectsOf(recorded, 1));
  return store;
}

async function scanOf(store: Store) {
  const rows = await store.scan(recordedIdentityVersions);
  return { data: await dataOf(rows), failedItems: rows.failures.map(({ item }) => item) };
}

describe("the recorded identity versions", () => {
  it("hold the identifier and the link of a Signed Identity that a Written Object among the records links to, and none of one that is held and not recorded", async () => {
    const recorded = await publish(signer(ed25519, 61), { at: 1_000 });
    const unrecorded = await publish(signer(ed25519, 62), { at: 1_000 });
    const store = await storeRecording(
      [recorded.link],
      [recorded.link, unrecorded.link],
      [...recorded.blobs, ...unrecorded.blobs],
    );
    expect(await scanOf(store)).toEqual({
      data: [{ identifier: new LinkValue(recorded.identity.identifier), signedIdentity: new LinkValue(recorded.link) }],
      failedItems: [],
    });
  });

  it("hold none of what was written that is not a Signed Identity, and that is no failure", async () => {
    const rootKey = keys.encode(signer(ed25519, 63).key);
    const store = await storeRecording([rootKey.link], [rootKey.link], rootKey.blobs);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [] });
  });

  it("fail on a Signed Identity written that another key signed, and not on the Written Object that links to it", async () => {
    const { identity, blobs } = await publish(signer(ed25519, 64), { at: 1_000 });
    const forged = objectFormat.encode(
      new ObjectValue(signedIdentities.schema.link, {
        identity: new LinkValue(identity.link),
        signature: await signer(ed25519, 65).sign(digestOf(identity.link)),
      }),
    );
    const store = await storeRecording([linkOf(forged)], [linkOf(forged)], [forged, ...blobs]);
    expect(await scanOf(store)).toEqual({ data: [], failedItems: [linkOf(forged)] });
  });
});
