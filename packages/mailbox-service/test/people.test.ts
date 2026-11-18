import { ed25519 } from "@estoc/identity";
import { encodeObject, LinkValue } from "@estoc/object";
import { scan, view } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { peopleView } from "../src/people.ts";
import { identityVersions, memoryStore, publish, signedIdentities, signer } from "./fixtures.ts";

describe("the index of the people of a store", () => {
  it("gives no row of a signed identity that its root did not sign, and lists it among the failures", async () => {
    const alice = signer(ed25519, 1);
    const first = await publish(alice, { at: 1_000 });
    const second = await publish(alice, { prior: first, at: 2_000 });
    const forged = encodeObject(signedIdentities.schema, {
      identity: new LinkValue(second.identity.link),
      signature: new Uint8Array(64),
    });
    const store = memoryStore();
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
