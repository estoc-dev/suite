import { ed25519, eip191, loadIdentity } from "@estoc/identity";
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
import { describe, expect, it } from "vitest";
import { IdentityVersions } from "../src/identity-versions.ts";
import {
  byLink,
  bytesOf,
  identityVersions,
  key,
  keys,
  peopleHavingSeen,
  publish,
  signedIdentities,
  signer,
} from "./fixtures.ts";

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
    expect(identityVersions.identityVersionOf(signedIdentity)).toEqual({
      identifier: new LinkValue(signedIdentity.identity.identifier),
      at: 1_000,
      signedIdentity: new LinkValue(signedIdentity.link),
    });
  });

  it("names itself as its last crisis when it is a crisis", async () => {
    const crisis = await publish(root, { prior: await publish(root, { at: 1_000 }), isCrisis: true, at: 2_000 });
    expect(identityVersions.identityVersionOf(crisis)).toEqual({
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
    expect(identityVersions.identityVersionOf(after)).toEqual({
      identifier: new LinkValue(after.identity.identifier),
      at: 4_000,
      signedIdentity: new LinkValue(after.link),
      lastCrisis: new LinkValue(crisis.link),
    });
  });
});

describe("the rows of a signed identity", () => {
  it("are the one of its identity version", async () => {
    const signedIdentity = await publish(signer(ed25519), { at: 1_000 });
    expect(identityVersions.rows(signedIdentity)).toEqual([identityVersions.identityVersionOf(signedIdentity)]);
  });
});

describe("the selection of identity versions", () => {
  const { selection } = identityVersions;
  const root = signer(ed25519, 4);

  it.each([
    ["with no agents", () => publish(root, { at: 1_000 })],
    ["with agents", () => publish(root, { agents: [key(ed25519, 2)], at: 1_000 })],
    ["that follows another", async () => publish(root, { prior: await publish(root, { at: 500 }), at: 1_000 })],
  ])("reads the signed identity of an identity %s as the implementation does", async (_, signIdentity) => {
    const signedIdentity = await signIdentity();
    const reader = byLink(signedIdentity.blobs);
    const object = decodeObject(bytesOf(signedIdentity), signedIdentities.schema);
    expect(await selection.read(signedIdentity.link, reader)).toEqual(
      await signedIdentities.implementation.read(object, reader),
    );
  });

  it("reads an object already read with its schema from the blobs it links to alone", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
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

  it("refuses a signed identity whose root's scheme the application does not accept", async () => {
    const ed25519IdentityVersions = new IdentityVersions(loadIdentity([ed25519]).signedIdentities);
    const signedIdentity = await publish(signer(eip191), { at: 1_000 });
    await expect(
      ed25519IdentityVersions.selection.read(signedIdentity.link, byLink(signedIdentity.blobs)),
    ).rejects.toThrow(/is not a schema read here/);
  });

  it("refuses a signed identity whose identity the reader does not give, by the reader's error", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
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
