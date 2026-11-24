import { ed25519, eip191, loadIdentity, SoftwareSigner } from "@estoc/identity";
import {
  AbsentBlob,
  decodeObject,
  digestOf,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type ValueMap,
} from "@estoc/object";
import { MemoryBackend, Store, scan } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { identityVersionOf, identityVersions, verifiedSignedIdentities } from "../src/identity-versions.ts";
import { byLink, bytesOf, key, keys, peopleHavingSeen, publish, signedIdentities, signer } from "./fixtures.ts";

const writtenSigned = (data: ValueMap) => objectFormat.encode(new ObjectValue(signedIdentities.schema.link, data));
const unsignedOf = (identity: Link<unknown>) =>
  writtenSigned({ identity: new LinkValue(identity), signature: new Uint8Array() });

describe("the identity version of a signed identity", () => {
  const root = signer(ed25519);

  it.each([
    ["with no agents", () => publish(root, { at: 1_000 })],
    ["with agents", () => publish(root, { agents: [key(ed25519, 2)], at: 1_000 })],
  ])("is the identifier, the at and the link of an identity %s", async (_, signIdentity) => {
    const signedIdentity = await signIdentity();
    expect(identityVersionOf(signedIdentity)).toEqual({
      identifier: new LinkValue(signedIdentity.identity.identifier),
      at: 1_000,
      signedIdentity: new LinkValue(signedIdentity.link),
    });
  });

  it("names itself as its last crisis when it is a crisis", async () => {
    const crisis = await publish(root, { prior: await publish(root, { at: 1_000 }), isCrisis: true, at: 2_000 });
    expect(identityVersionOf(crisis)).toEqual({
      identifier: new LinkValue(crisis.identity.identifier),
      at: 2_000,
      signedIdentity: new LinkValue(crisis.link),
      lastCrisis: new LinkValue(crisis.link),
    });
  });

  it("names as its last crisis the latest crisis it follows", async () => {
    const first = await publish(root, { isCrisis: true, at: 1_000 });
    const crisis = await publish(root, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(root, { prior: await publish(root, { prior: crisis, at: 3_000 }), at: 4_000 });
    expect(identityVersionOf(after)).toEqual({
      identifier: new LinkValue(after.identity.identifier),
      at: 4_000,
      signedIdentity: new LinkValue(after.link),
      lastCrisis: new LinkValue(crisis.link),
    });
  });
});

describe("the index of identity versions", () => {
  it("gives the row of each identity version the store holds, by identifier and then by at", async () => {
    const identifierOf = (root: SoftwareSigner) => keys.encode(root.key).link;
    const [lesser, greater] = [signer(ed25519, 5), signer(ed25519, 6)].sort((a, b) =>
      identifierOf(a) < identifierOf(b) ? -1 : 1,
    ) as [SoftwareSigner, SoftwareSigner];
    const first = await publish(lesser, { at: 2_000 });
    const second = await publish(lesser, { prior: first, at: 3_000 });
    const ofGreater = await publish(greater, { at: 1_000 });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [ofGreater.link, second.link], blobs: [...ofGreater.blobs, ...second.blobs] });

    const rows = [];
    for await (const { data } of (await scan(store, identityVersions)).range([])) rows.push(data);
    expect(rows).toEqual([identityVersionOf(first), identityVersionOf(second), identityVersionOf(ofGreater)]);
  });
});

describe("the selection of identity versions", () => {
  const selection = verifiedSignedIdentities;
  // The kit that the selection reads by keeps what it has signed or verified, so what the selection
  // is to read from a reader is published by another kit, as a root that signs nothing else.
  const elsewhere = loadIdentity([ed25519]);
  const freshRoot = () => SoftwareSigner.fromSecretKey(ed25519, crypto.getRandomValues(new Uint8Array(32)));
  const root = signer(ed25519, 4);

  it.each([
    ["with no agents", () => elsewhere.publish(freshRoot(), { at: 1_000 })],
    ["with agents", () => elsewhere.publish(freshRoot(), { agents: [key(ed25519, 2)], at: 1_000 })],
    [
      "that follows another",
      async () => {
        const root = freshRoot();
        return elsewhere.publish(root, { prior: await elsewhere.publish(root, { at: 500 }), at: 1_000 });
      },
    ],
  ])("reads the signed identity of an identity %s as the implementation does", async (_, signIdentity) => {
    const signedIdentity = await signIdentity();
    const reader = byLink(signedIdentity.blobs);
    const object = decodeObject(bytesOf(signedIdentity), signedIdentities.schema);
    expect(await selection.read(signedIdentity.link, reader)).toEqual(
      await loadIdentity([ed25519]).signedIdentities.implementation.read(object, reader),
    );
  });

  it("reads an object already read with its schema from the blobs it links to alone", async () => {
    const signedIdentity = await elsewhere.publish(freshRoot(), { at: 1_000 });
    const object = decodeObject(bytesOf(signedIdentity), signedIdentities.schema);
    const linkedBlobs = byLink(signedIdentity.blobs.filter((bytes) => linkOf(bytes) !== signedIdentity.link));
    expect((await selection.itemOf(object, linkedBlobs))?.link).toBe(signedIdentity.link);
  });

  it("refuses a signed identity that another key signed", async () => {
    const { identity, blobs } = await publish(root, { at: 1_000 });
    const forgedBytes = writtenSigned({
      identity: new LinkValue(identity.link),
      signature: await signer(ed25519, 9).sign(digestOf(identity.link)),
    });
    const reader = byLink([forgedBytes, ...blobs]);
    await expect(selection.read(linkOf(forgedBytes), reader)).rejects.toThrow(/did not sign/);
    await expect(
      Promise.resolve(selection.itemOf(decodeObject(forgedBytes, signedIdentities.schema), reader)),
    ).rejects.toThrow(/did not sign/);
  });

  it("refuses a signed identity that names what is not an identity", async () => {
    const rootKey = keys.encode(root.key);
    const signedIdentityBytes = unsignedOf(rootKey.link);
    const reader = byLink([signedIdentityBytes, ...rootKey.blobs]);
    await expect(selection.read(linkOf(signedIdentityBytes), reader)).rejects.toThrow(/is written to/);
  });

  it("throws on reading a record that names the signed identity schema and does not fit it", async () => {
    const { identity } = await publish(root, { at: 1_000 });
    const unfitBytes = writtenSigned({ identity: new LinkValue(identity.link) });
    await expect(selection.read(linkOf(unfitBytes), byLink([unfitBytes]))).rejects.toThrow(/does not fit/);
  });

  it("refuses a signed identity whose identity the reader does not give, by the reader's error", async () => {
    const signedIdentity = await elsewhere.publish(freshRoot(), { at: 1_000 });
    const failingReader = {
      get: async (link: Link<unknown>) => {
        if (link === signedIdentity.link) return bytesOf(signedIdentity);
        throw new Error("the disk failed");
      },
    };
    const error = await selection
      .read(signedIdentity.link, byLink([bytesOf(signedIdentity)]))
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AbsentBlob);
    expect(error).toHaveProperty("link", signedIdentity.identity.link);
    await expect(selection.read(signedIdentity.link, failingReader)).rejects.toThrow("the disk failed");
  });

  it("leaves out an object of another schema", async () => {
    const rootKey = keys.encode(root.key);
    expect(await selection.read(rootKey.link, byLink(rootKey.blobs))).toBeUndefined();
  });
});

describe("the identity versions a reader has seen", () => {
  const wallet = signer(eip191);

  it("give as current the identity version of a root with the greatest at", async () => {
    const earlier = await publish(wallet, { agents: [key(ed25519, 3)], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, agents: [key(ed25519, 2)], at: 2_000 });
    expect((await peopleHavingSeen(later, earlier).current(earlier)).link).toBe(later.link);
  });

  it("give as current of two identity versions at the same at that whose signed identity has the greater link", async () => {
    const first = await publish(wallet, { at: 500 });
    const [one, other] = await Promise.all([
      publish(wallet, { prior: first, agents: [key(ed25519, 2)], at: 1_000 }),
      publish(wallet, { prior: first, agents: [key(ed25519, 3)], at: 1_000 }),
    ]);
    const greater = one.link > other.link ? one : other;
    const lesser = greater === one ? other : one;
    expect((await peopleHavingSeen(lesser, greater).current(lesser)).link).toBe(greater.link);
    expect((await peopleHavingSeen(lesser).current(greater)).link).toBe(greater.link);
  });

  it("give the identity version given as current when it is later than any of them", async () => {
    const earlier = await publish(wallet, { agents: [key(ed25519, 2)], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, agents: [key(ed25519, 3)], at: 2_000 });
    expect((await peopleHavingSeen(earlier).current(later)).link).toBe(later.link);
  });

  it("give the identity version given as current when none of them is of its root", async () => {
    const signedIdentity = await publish(wallet, { agents: [key(ed25519, 2)], at: 1_000 });
    const other = await publish(signer(ed25519, 4), { agents: [key(ed25519, 2)], at: 2_000 });
    expect((await peopleHavingSeen(other).current(signedIdentity)).link).toBe(signedIdentity.link);
  });

  it("give as current the latest identity version, whether it lists agents or not", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const delegated = await publish(wallet, { prior: published, agents: [key(ed25519, 2)], at: 2_000 });
    const republished = await publish(wallet, { prior: delegated, at: 3_000 });
    expect((await peopleHavingSeen(delegated).current(published)).link).toBe(delegated.link);
    expect((await peopleHavingSeen(published, republished).current(delegated)).link).toBe(republished.link);
  });

  it("give as current the latest that follows the latest crisis, not a later one on a branch the crisis cuts", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [key(ed25519, 2)], at: 3_000 });
    expect((await peopleHavingSeen(crisis, branch).current(first)).link).toBe(crisis.link);
    expect((await peopleHavingSeen(crisis).current(branch)).link).toBe(crisis.link);
  });

  it("give as current a later crisis on another branch over the identity versions that follow an earlier one", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, at: 4_000 });
    const later = await publish(wallet, { prior: first, isCrisis: true, at: 3_000 });
    expect((await peopleHavingSeen(after, later).current(first)).link).toBe(later.link);
  });
});
