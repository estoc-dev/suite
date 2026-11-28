import { ed25519, eip191, loadIdentity, type Signer, SoftwareSigner } from "@estoc/identity";
import { digestOf, type Link, LinkValue, linkOf, ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { type Index, MemoryBackend, recordedWrittenObjects, Store, writtenObjectsOf } from "@estoc/store";
import { describe, expect, it } from "vitest";
import {
  type IdentityVersionData,
  identityVersionOf,
  identityVersions,
  identityVersionsOver,
} from "../src/identity-versions.ts";
import { key, keys, peopleHavingSeen, publish, signedIdentities, signer } from "./fixtures.ts";

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

async function scanOf(store: Store, index: Index<IdentityVersionData>) {
  const rows = await store.scan(index);
  const data: IdentityVersionData[] = [];
  for await (const row of rows) data.push(row.data);
  return { data, failedItems: rows.failures.map(({ item }) => item) };
}

async function storeHolding(roots: readonly Link<unknown>[], blobs: readonly Uint8Array[]): Promise<Store> {
  const store = new Store(new MemoryBackend());
  await store.write({ roots, blobs: [...blobs, ...signedIdentities.schema.blobs] });
  return store;
}

describe("the index of identity versions", () => {
  // The kit that the index reads by keeps what it has signed or verified, so what the index is to
  // verify is published by another kit, as a root that signs nothing else.
  const elsewhere = loadIdentity([ed25519]);
  const freshRoot = () => SoftwareSigner.fromSecretKey(ed25519, crypto.getRandomValues(new Uint8Array(32)));
  const root = signer(ed25519, 4);

  it("gives the row of each identity version the store holds", async () => {
    const first = await publish(signer(ed25519, 5), { at: 2_000 });
    const second = await publish(signer(ed25519, 5), { prior: first, at: 3_000 });
    const ofAnother = await publish(signer(ed25519, 6), { at: 1_000 });
    const store = await storeHolding([ofAnother.link, second.link], [...ofAnother.blobs, ...second.blobs]);

    const { data, failedItems } = await scanOf(store, identityVersions);
    expect(data).toHaveLength(3);
    expect(data).toEqual(
      expect.arrayContaining([identityVersionOf(first), identityVersionOf(second), identityVersionOf(ofAnother)]),
    );
    expect(failedItems).toEqual([]);
  });

  it.each([
    ["with no agents", (root: Signer) => elsewhere.publish(root, { at: 1_000 })],
    ["with agents", (root: Signer) => elsewhere.publish(root, { agents: [key(ed25519, 2)], at: 1_000 })],
  ])("gives the row of an identity version %s that it has not read before", async (_, signIdentity) => {
    const signedIdentity = await signIdentity(freshRoot());
    const store = await storeHolding([signedIdentity.link], signedIdentity.blobs);
    expect(await scanOf(store, identityVersions)).toEqual({
      data: [identityVersionOf(signedIdentity)],
      failedItems: [],
    });
  });

  it("fails on a Signed Identity that another key signed", async () => {
    const { identity, blobs } = await publish(root, { at: 1_000 });
    const forgedBytes = writtenSigned({
      identity: new LinkValue(identity.link),
      signature: await signer(ed25519, 9).sign(digestOf(identity.link)),
    });
    const store = await storeHolding([linkOf(forgedBytes)], [forgedBytes, ...blobs]);
    expect(await scanOf(store, identityVersions)).toEqual({ data: [], failedItems: [linkOf(forgedBytes)] });
  });

  it("fails on a Signed Identity that names what is not an identity", async () => {
    const rootKey = keys.encode(root.key);
    const signedIdentityBytes = unsignedOf(rootKey.link);
    const store = await storeHolding([linkOf(signedIdentityBytes)], [signedIdentityBytes, ...rootKey.blobs]);
    expect(await scanOf(store, identityVersions)).toEqual({ data: [], failedItems: [linkOf(signedIdentityBytes)] });
  });

  it("fails on an object that names the schema of a Signed Identity and does not fit it", async () => {
    const { identity, blobs } = await publish(root, { at: 1_000 });
    const misfit = writtenSigned({ identity: new LinkValue(identity.link) });
    const store = await storeHolding([linkOf(misfit)], [misfit, ...blobs]);
    expect(await scanOf(store, identityVersions)).toEqual({ data: [], failedItems: [linkOf(misfit)] });
  });

  it("gives no row of an object of another schema, and that is no failure", async () => {
    const rootKey = keys.encode(root.key);
    const store = await storeHolding([rootKey.link], rootKey.blobs);
    expect(await scanOf(store, identityVersions)).toEqual({ data: [], failedItems: [] });
  });
});

describe("the identity versions over a collection", () => {
  const recordedVersions = identityVersionsOver(recordedWrittenObjects.linksAt("object"));

  it("hold the row of a Signed Identity given, and none of one that is held and not given", async () => {
    const recordedVersion = await publish(signer(ed25519, 7), { at: 1_000 });
    const unrecordedVersion = await publish(signer(ed25519, 8), { at: 1_000 });
    const store = await storeHolding(
      [recordedVersion.link, unrecordedVersion.link],
      [...recordedVersion.blobs, ...unrecordedVersion.blobs],
    );
    await store.record(writtenObjectsOf([recordedVersion.link], 1));
    expect(await scanOf(store, recordedVersions)).toEqual({
      data: [identityVersionOf(recordedVersion)],
      failedItems: [],
    });
  });

  it("hold none of what the collection gives that is not a Signed Identity, and that is no failure", async () => {
    const rootKey = keys.encode(signer(ed25519, 4).key);
    const store = await storeHolding([rootKey.link], rootKey.blobs);
    await store.record(writtenObjectsOf([rootKey.link], 1));
    expect(await scanOf(store, recordedVersions)).toEqual({ data: [], failedItems: [] });
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
