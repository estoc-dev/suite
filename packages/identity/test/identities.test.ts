import {
  decodeObject,
  digestOf,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  json,
  jsonSchema,
  type Link,
  linkOf,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assert, describe, expect, it, vi } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  hasSigner,
  identitySchema,
  isSameKey,
  type Key,
  loadIdentity,
  type SignedIdentityData,
  type SignedIdentityObject,
  SoftwareSigner,
  schemeSchema,
  signedIdentitySchema,
  solanaOffchain,
} from "../src/index.ts";
import { byLink, closure, rowsOf, schemes } from "./fixtures.ts";

const { keys, identities, signedIdentities, identityVersions, publish } = await loadIdentity(defaultValidator, schemes);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const written = (data: JsonObject) => json.encode(json.object(data, identities.schema.link));
const writtenSigned = (data: JsonObject) => json.encode(json.object(data, signedIdentities.schema.link));
// A signed identity's identity is read before its root's signature is
// verified, so one that names an identity that does not read is refused for
// the identity, whatever its signature.
const unsignedOf = (identity: Link<unknown>) => writtenSigned({ identity: { $link: identity }, signature: "" });
const readFrom = (bytes: Uint8Array, ...blobs: Uint8Array[]) => {
  const signed = unsignedOf(linkOf(bytes));
  return signedIdentities.read(linkOf(signed), byLink([signed, bytes, ...blobs]));
};
// The link and the bytes of a signed identity of `data`, written as an identity and signed by `root`.
const signedFrom = async (root: SoftwareSigner, data: JsonObject) => {
  const bytes = written(data);
  const signed = writtenSigned({
    identity: { $link: linkOf(bytes) },
    signature: bytesToHex(await root.sign(digestOf(linkOf(bytes)))),
  });
  return { link: linkOf(signed), blobs: [signed, bytes] };
};
const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));

describe("an identity", () => {
  it("names its root by the link of the root's object, and holds its agents and its at", () => {
    const identity = identities.encode(key(ed25519), { at: 1_000 });
    expect(identity.data).toEqual({ root: { $link: keys.encode(key(ed25519)).link }, agents: [], at: 1_000 });
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key(ed25519);
    const plain = identities.encode({ scheme: ed25519, publicKey }, { at: 0 });
    const solana = identities.encode({ scheme: solanaOffchain, publicKey }, { at: 0 });
    expect(plain.schema.link).toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("has its root and its agents sign for it, and no other key, as it is read", async () => {
    const signed = await publish(signer(ed25519), { agents: [key(ed25519, 2)] });
    const { identity } = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(hasSigner(identity, identity.root)).toBe(true);
    expect(hasSigner(identity, keys.encode(key(ed25519, 2)))).toBe(true);
    expect(hasSigner(identity, keys.encode(key(ed25519, 3)))).toBe(false);
  });

  it("carries as its blobs its object, its root's, and the blobs of the schemas they are written to, each once", async () => {
    const identity = identities.encode(key(eip191), { at: 0 });
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keyScheme = await encodeSchema(schemeSchema, defaultValidator);
    expect(linksOf(identity.blobs)).toEqual([
      identity.link,
      identity.root.link,
      schema.link,
      jsonSchema.link,
      identity.root.schema.link,
      keyScheme.link,
    ]);
  });

  it("is refused without the blob of its root", async () => {
    await expect(readFrom(identities.encode(key(ed25519), { at: 0 }).bytes)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key(ed25519), { at: 0 });
    await expect(readFrom(written({ root: { $link: other.link }, agents: [], at: 0 }), other.bytes)).rejects.toThrow(
      `${other.schema.link} is not a schema read here`,
    );
  });

  it.each<[string, (root: JsonObject) => JsonObject]>([
    ["a field besides prior, root, agents, crisis and at", (root) => ({ root, agents: [], at: 0, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.$link as string, agents: [], at: 0 })],
    ["no root", () => ({ agents: [], at: 0 })],
    ["no agents", (root) => ({ root, at: 0 })],
    ["no at", (root) => ({ root, agents: [] })],
    ["a negative at", (root) => ({ root, agents: [], at: -1 })],
    ["an at that is not a whole number", (root) => ({ root, agents: [], at: 1.5 })],
    ["crisis set to false", (root) => ({ root, agents: [], crisis: false, at: 0 })],
    ["its prior as a bare string", (root) => ({ prior: root.$link as string, root, agents: [], at: 0 })],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key(ed25519));
    await expect(readFrom(written(data({ $link: root.link })), root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("is refused when it is written to another schema", async () => {
    const other = keys.encode(key(ed25519));
    await expect(readFrom(other.bytes)).rejects.toThrow(`the object is written to ${other.schema.link}`);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const signed = unsignedOf(identity.link);
    const reader = new Map([
      [linkOf(signed), signed],
      [identity.link, other.bytes],
    ]);
    await expect(signedIdentities.read(linkOf(signed), reader)).rejects.toThrow(/another blob/);
  });

  it("is a crisis when its root marks it as one, and holds no crisis otherwise", () => {
    expect(identities.encode(key(ed25519), { isCrisis: true, at: 0 }).data.crisis).toBe(true);
    expect(identities.encode(key(ed25519), { at: 0 }).data).not.toHaveProperty("crisis");
  });
});

describe("a signed identity", () => {
  const readSignedFrom = (bytes: Uint8Array, ...blobs: readonly Uint8Array[]) =>
    signedIdentities.read(linkOf(bytes), byLink([bytes, ...blobs]));
  const signedBy = async (by: SoftwareSigner, identity = identities.encode(by.key, { at: 0 })) => ({
    identity: { $link: identity.link },
    signature: bytesToHex(await by.sign(digestOf(identity.link))),
  });

  it("is refused by verify when it is written to another schema", async () => {
    const otherSchema: Schema<Json, SignedIdentityData> = await encodeSchema(
      { ...signedIdentitySchema, title: "Another" },
      defaultValidator,
    );
    const by = signer(ed25519);
    const object = encodeObject(otherSchema, await signedBy(by));
    await expect(signedIdentities.verify(object, byLink(identities.encode(by.key, { at: 0 }).blobs))).rejects.toThrow(
      /a signed identity is written to/,
    );
  });

  it.each(schemes)("published by a $name root reads back from its blobs with its identity", async (scheme) => {
    const signed = await publish(signer(scheme), { at: 1_000 });
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.link).toBe(signed.link);
    expect(read.identity).toEqual(identities.encode(key(scheme), { at: 1_000 }));
    expect(isSameKey(read.identity.root, key(scheme))).toBe(true);
    expect(read.signature).toEqual(signed.signature);
  });

  it("carries as its blobs its object, its schema's blobs, and its identity's", async () => {
    const signed = await publish(signer(ed25519));
    const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
    expect(linksOf(signed.blobs)).toEqual([
      signed.link,
      schema.link,
      jsonSchema.link,
      ...linksOf(signed.identity.blobs),
    ]);
  });

  it.each(schemes)("published by a $name root carries its closure as its blobs, and nothing else", async (scheme) => {
    const signed = await publish(signer(scheme));
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("is refused when another key signed it", async () => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const bytes = writtenSigned(await signedBy(signer(ed25519, 2), identity));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused when it names another identity than its root signed", async () => {
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const data = { ...(await signedBy(signer(ed25519))), identity: { $link: other.link } };
    await expect(readSignedFrom(writtenSigned(data), ...other.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused without the blobs of its identity", async () => {
    await expect(readSignedFrom(writtenSigned(await signedBy(signer(ed25519))))).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (signed: JsonObject) => JsonObject]>([
    ["a field besides identity and signature", (signed) => ({ ...signed, at: 0 })],
    ["its signature in uppercase hex", (signed) => ({ ...signed, signature: String(signed.signature).toUpperCase() })],
    ["no signature", ({ signature: _, ...signed }) => signed],
  ])("is refused with %s", async (_, change) => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const bytes = writtenSigned(change(await signedBy(signer(ed25519))));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/does not fit/);
  });

  it("is at the time it is given", async () => {
    const { identity } = await publish(signer(ed25519), { at: 1_767_225_600_000 });
    expect(identity.data.at).toBe(1_767_225_600_000);
  });

  it("is at the time of the clock when it is given none", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z"), toFake: ["Date"] });
    try {
      const { identity } = await publish(signer(ed25519));
      expect(identity.data.at).toBe(Date.parse("2026-10-30T12:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the agents of an identity", () => {
  const distinctKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const secretKey = new Uint8Array(32).fill(9);
      new DataView(secretKey.buffer).setUint16(30, i);
      return SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    });

  it("read back from its blobs in the order its root lists them", async () => {
    const agents = [key(ed25519, 3), key(solanaOffchain, 2), key(eip191, 4)];
    const signed = await publish(signer(eip191), { agents });
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.identity).toEqual(signed.identity);
    expect(isSameKey(read.identity.root, key(eip191))).toBe(true);
    expect(read.identity.agents.map(({ link }) => link)).toEqual(agents.map((agent) => keys.encode(agent).link));
  });

  it("are named by the links of their objects", async () => {
    const { identity } = await publish(signer(ed25519), { agents: [key(ed25519, 2)], at: 1_000 });
    expect(identity.data).toEqual({
      root: { $link: keys.encode(key(ed25519)).link },
      agents: [{ $link: keys.encode(key(ed25519, 2)).link }],
      at: 1_000,
    });
  });

  it("make another identity of the same root", async () => {
    const { identity } = await publish(signer(ed25519), { agents: [key(ed25519, 2)], at: 0 });
    const own = identities.encode(key(ed25519), { at: 0 });
    expect(identity.link).not.toBe(own.link);
    expect(identity.root.link).toBe(own.root.link);
  });

  it("in another scheme than the root are carried with each blob of the closure once, and nothing else", async () => {
    const signed = await publish(signer(eip191), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const links = linksOf(signed.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("are carried with the root and the blobs of the schemas they are written to, each once", async () => {
    const { identity } = await publish(signer(eip191), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keyScheme = await encodeSchema(schemeSchema, defaultValidator);
    const [first, second] = identity.agents;
    assert.exists(first);
    assert.exists(second);
    expect(linksOf(identity.blobs)).toEqual([
      identity.link,
      identity.root.link,
      first.link,
      second.link,
      schema.link,
      jsonSchema.link,
      identity.root.schema.link,
      keyScheme.link,
      first.schema.link,
    ]);
  });

  it("are refused when one is not a key", async () => {
    const root = keys.encode(key(ed25519));
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const bytes = written({ root: { $link: root.link }, agents: [{ $link: other.link }], at: 0 });
    await expect(readFrom(bytes, root.bytes, other.bytes)).rejects.toThrow(
      `${other.schema.link} is not a schema read here`,
    );
  });

  it("are refused when they list the root", async () => {
    const root = keys.encode(key(ed25519));
    const bytes = written({ root: { $link: root.link }, agents: [{ $link: root.link }], at: 0 });
    await expect(readFrom(bytes, root.bytes)).rejects.toThrow(/lists its root as an agent/);
  });

  it("can be none", async () => {
    const signed = await publish(signer(ed25519), { agents: [] });
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.identity.agents).toEqual([]);
  });

  it("can be 255", async () => {
    const signed = await publish(signer(ed25519), { agents: distinctKeys(255) });
    expect(signed.identity.agents).toHaveLength(255);
  });

  it.each<[string, Key[], RegExp]>([
    ["one agent twice", [key(ed25519, 2), key(ed25519, 3), key(ed25519, 2)], /does not fit/],
    ["256 agents", distinctKeys(256), /does not fit/],
    ["the root among them", [key(ed25519, 2), key(ed25519)], /lists its root as an agent/],
  ])("with %s are refused before the root is asked to sign", async (_, agents, error) => {
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(publish({ key: key(ed25519), sign }, { agents })).rejects.toThrow(error);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("an identity that follows another", () => {
  const root = signer(eip191);

  it("names the signed identity it follows, and reads back from its blobs with it", async () => {
    const first = await publish(root, { at: 1_000 });
    const second = await publish(root, { prior: first, agents: [key(ed25519, 2)], at: 2_000 });
    expect(second.identity.data.prior).toEqual({ $link: first.link });
    const read = await signedIdentities.read(second.link, byLink(second.blobs));
    expect(read.identity.prior?.link).toBe(first.link);
    expect(read.identity.prior?.identity).toEqual(first.identity);
  });

  it("carries the closure of every identity version it follows, each blob once, and nothing else", async () => {
    const first = await publish(root, { agents: [key(ed25519, 2)], at: 1_000 });
    const second = await publish(root, { prior: first, agents: [key(ed25519, 3)], at: 2_000 });
    const third = await publish(root, { prior: second, isCrisis: true, at: 3_000 });
    const links = linksOf(third.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    expect(links).toEqual(expect.arrayContaining([first.link, second.link, ...linksOf(first.blobs)]));
    const blobs = byLink(third.blobs);
    expect(closure(third.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it.each<[string, Key, number, RegExp]>([
    ["an identity version of another root", key(ed25519, 2), 2_000, /has another root/],
    ["an identity version at the same at", key(eip191), 1_000, /is not later/],
  ])("is refused before its root is asked to sign when it follows %s", async (_, rootKey, at, error) => {
    const prior = await publish(root, { at: 1_000 });
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(publish({ key: rootKey, sign }, { prior, at })).rejects.toThrow(error);
    expect(sign).not.toHaveBeenCalled();
  });

  it.each<[string, SoftwareSigner, number, RegExp]>([
    ["an identity version of another root", signer(ed25519, 2), 2_000, /has another root/],
    ["a later identity version", root, 500, /is not later/],
  ])("is refused as it is read when it follows %s", async (_, by, at, error) => {
    const prior = await publish(root, { at: 1_000 });
    const rootKey = keys.encode(by.key);
    const signed = await signedFrom(by, {
      prior: { $link: prior.link },
      root: { $link: rootKey.link },
      agents: [],
      at,
    });
    const reader = byLink([...signed.blobs, rootKey.bytes, ...rootKey.schema.blobs, ...prior.blobs]);
    await expect(signedIdentities.read(signed.link, reader)).rejects.toThrow(error);
  });

  it("is refused without the blobs of the identity version it follows", async () => {
    const first = await publish(root, { at: 1_000 });
    const second = await publish(root, { prior: first, at: 2_000 });
    const without = second.blobs.filter((bytes) => linkOf(bytes) !== first.link);
    await expect(signedIdentities.read(second.link, byLink(without))).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root did not sign the identity version it follows", async () => {
    const first = await publish(root, { at: 1_000 });
    const forged = writtenSigned({
      identity: { $link: first.identity.link },
      signature: bytesToHex(await signer(eip191, 9).sign(digestOf(first.identity.link))),
    });
    const rootKey = keys.encode(root.key);
    const second = await signedFrom(root, {
      prior: { $link: linkOf(forged) },
      root: { $link: rootKey.link },
      agents: [],
      at: 2_000,
    });
    await expect(signedIdentities.read(second.link, byLink([...second.blobs, forged, ...first.blobs]))).rejects.toThrow(
      /did not sign/,
    );
  });
});

describe("the identity version of a signed identity", () => {
  const root = signer(ed25519);

  it.each([
    ["with no agents", () => publish(root, { at: 1_000 })],
    ["with agents", () => publish(root, { agents: [key(ed25519, 2)], at: 1_000 })],
  ])("is the root, the at and the link of an identity %s", async (_, signed) => {
    const signedIdentity = await signed();
    expect(identityVersions.identityVersionOf(signedIdentity)).toEqual([
      signedIdentity.identity.root.link,
      1_000,
      signedIdentity.link,
    ]);
  });

  it("names itself as its last crisis when it is a crisis", async () => {
    const crisis = await publish(root, { prior: await publish(root, { at: 1_000 }), isCrisis: true, at: 2_000 });
    expect(identityVersions.identityVersionOf(crisis)).toEqual([
      crisis.identity.root.link,
      2_000,
      crisis.link,
      crisis.link,
    ]);
  });

  it("names as its last crisis the latest crisis it follows", async () => {
    const first = await publish(root, { isCrisis: true, at: 1_000 });
    const crisis = await publish(root, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(root, { prior: await publish(root, { prior: crisis, at: 3_000 }), at: 4_000 });
    expect(identityVersions.identityVersionOf(after)).toEqual([
      after.identity.root.link,
      4_000,
      after.link,
      crisis.link,
    ]);
  });
});

describe("the selection of identity versions", () => {
  const { selection } = identityVersions;
  const root = signer(ed25519, 4);

  it.each([
    ["with no agents", () => publish(root, { at: 1_000 })],
    ["with agents", () => publish(root, { agents: [key(ed25519, 2)], at: 1_000 })],
    ["that follows another", async () => publish(root, { prior: await publish(root, { at: 500 }), at: 1_000 })],
  ])("reads the signed identity of an identity %s as its identity version", async (_, signIdentity) => {
    const signedIdentity = await signIdentity();
    expect(await selection.read(signedIdentity.link, byLink(signedIdentity.blobs))).toEqual(
      identityVersions.identityVersionOf(signedIdentity),
    );
  });

  it("reads an object already read with its schema from the blobs it links to alone", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const object = decodeObject(signedIdentity.bytes, signedIdentities.schema);
    const linkedBlobs = byLink(signedIdentity.blobs.filter((bytes) => linkOf(bytes) !== signedIdentity.link));
    expect(await selection.itemOf(object, linkedBlobs)).toEqual(identityVersions.identityVersionOf(signedIdentity));
  });

  it("leaves out a signed identity that another key signed", async () => {
    const { identity, blobs } = await publish(root, { at: 1_000 });
    const forgedBytes = writtenSigned({
      identity: { $link: identity.link },
      signature: bytesToHex(await signer(ed25519, 9).sign(digestOf(identity.link))),
    });
    const reader = byLink([forgedBytes, ...blobs]);
    expect(await selection.read(linkOf(forgedBytes), reader)).toBeUndefined();
    expect(await selection.itemOf(decodeObject(forgedBytes, signedIdentities.schema), reader)).toBeUndefined();
  });

  it("leaves out a signed identity that names what is not an identity", async () => {
    const rootKey = keys.encode(root.key);
    const signedIdentityBytes = unsignedOf(rootKey.link);
    const reader = byLink([signedIdentityBytes, rootKey.bytes]);
    expect(await selection.read(linkOf(signedIdentityBytes), reader)).toBeUndefined();
  });

  it("throws on reading a record that names the signed identity schema and does not fit it", async () => {
    const { identity } = await publish(root, { at: 1_000 });
    const unfitBytes = writtenSigned({ identity: { $link: identity.link } });
    await expect(selection.read(linkOf(unfitBytes), byLink([unfitBytes]))).rejects.toThrow(/does not fit/);
  });

  it("leaves out a signed identity whose root's scheme the application does not accept", async () => {
    const { identityVersions: ed25519IdentityVersions } = await loadIdentity(defaultValidator, [ed25519]);
    const signedIdentity = await publish(signer(eip191), { at: 1_000 });
    expect(
      await ed25519IdentityVersions.selection.read(signedIdentity.link, byLink(signedIdentity.blobs)),
    ).toBeUndefined();
  });

  it("leaves out a signed identity whose identity the reader does not give", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const failingReader = {
      get: async (link: Link<unknown>) => {
        if (link === signedIdentity.link) return signedIdentity.bytes;
        throw new Error("the disk failed");
      },
    };
    expect(await selection.read(signedIdentity.link, byLink([signedIdentity.bytes]))).toBeUndefined();
    expect(await selection.read(signedIdentity.link, failingReader)).toBeUndefined();
  });

  it("leaves out an object of another schema", async () => {
    const rootKey = keys.encode(root.key);
    expect(await selection.read(rootKey.link, byLink([rootKey.bytes]))).toBeUndefined();
  });
});

describe("the identity versions a reader has seen", () => {
  const wallet = signer(eip191);
  const blobsOf = (...signed: { readonly blobs: readonly Uint8Array[] }[]) =>
    byLink(signed.flatMap(({ blobs }) => blobs));
  const peopleHavingSeen = (...signed: SignedIdentityObject[]) =>
    identityVersions.people(rowsOf(identityVersions, ...signed), blobsOf(...signed));

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
    const signed = await publish(wallet, { agents: [key(ed25519, 2)], at: 1_000 });
    const other = await publish(signer(ed25519, 4), { agents: [key(ed25519, 2)], at: 2_000 });
    expect((await peopleHavingSeen(other).current(signed)).link).toBe(signed.link);
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
