import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { encodeObject, LinkValue } from "@estoc/object";
import { MemoryBackend, Store, scan, view } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { peopleView } from "../src/index.ts";

const { identityVersions, signedIdentities, publish } = loadIdentity([ed25519]);

describe("the index of the people of a store", () => {
  it("gives no row of a signed identity that its root did not sign, and lists it among the failures", async () => {
    const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
    const first = await publish(alice, { at: 1_000 });
    const second = await publish(alice, { prior: first, at: 2_000 });
    const forged = encodeObject(signedIdentities.schema, {
      identity: new LinkValue(second.identity.link),
      signature: new Uint8Array(64),
    });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [second.link, forged.link], blobs: [...second.blobs, forged.bytes] });

    const people = peopleView(identityVersions);
    const rows = await scan(store, people.index);
    const signedIdentitiesOfRows = [];
    for await (const { data } of rows.range([])) signedIdentitiesOfRows.push(data.signedIdentity.link);
    expect(signedIdentitiesOfRows).toEqual([first.link, second.link]);
    expect(rows.failures.map(({ item }) => item)).toEqual([forged.link]);
    expect((await (await view(store, people)).current(first)).link).toBe(second.link);
  });
});
