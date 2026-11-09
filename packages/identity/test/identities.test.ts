import { digestOf, encodeSchema, type JsonObject, json, jsonSchema, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assert, describe, expect, it, vi } from "vitest";
import {
  type CurveScheme,
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  ed25519,
  eip191,
  hasSigner,
  type IdentityObject,
  identitySchema,
  isSameKey,
  type Key,
  loadIdentity,
  type SignedIdentityObject,
  SoftwareSigner,
  schemeSchema,
  signedIdentitySchema,
  solanaOffchain,
} from "../src/index.ts";
import { byLink, closure, rowsOf, schemes } from "./fixtures.ts";

const { keys, identities, delegatedIdentities, signedIdentities, versions, publish, delegate } = await loadIdentity(
  defaultValidator,
  schemes,
);

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

describe("an identity", () => {
  it("names its root by the link of the root's object, and holds its at", () => {
    const identity = identities.encode(key(ed25519), 1_000);
    expect(identity.data).toEqual({ root: { $link: keys.encode(key(ed25519)).link }, at: 1_000 });
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key(ed25519);
    const plain = identities.encode({ scheme: ed25519, publicKey }, 0);
    const solana = identities.encode({ scheme: solanaOffchain, publicKey }, 0);
    expect(plain.schema.link).toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("has its root alone sign for it, as it is read", async () => {
    const signed = await publish(signer(ed25519));
    const { identity } = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(hasSigner(identity, identity.root)).toBe(true);
    expect(hasSigner(identity, keys.encode(key(ed25519, 2)))).toBe(false);
  });

  it("carries as its blobs its object, its root's, and the blobs of the schemas they are written to, each once", async () => {
    const identity = identities.encode(key(eip191), 0);
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keyScheme = await encodeSchema(schemeSchema, defaultValidator);
    expect(identity.blobs.map((bytes) => linkOf(bytes))).toEqual([
      identity.link,
      identity.root.link,
      schema.link,
      jsonSchema.link,
      identity.root.schema.link,
      keyScheme.link,
    ]);
  });

  it("is refused without the blob of its root", async () => {
    await expect(readFrom(identities.encode(key(ed25519), 0).bytes)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key(ed25519), 0);
    await expect(readFrom(written({ root: { $link: other.link }, at: 0 }), other.bytes)).rejects.toThrow(
      `${other.schema.link} is not a schema read here`,
    );
  });

  it.each<[string, (root: JsonObject) => JsonObject]>([
    ["a field besides root and at", (root) => ({ root, at: 0, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.$link as string, at: 0 })],
    ["no root", () => ({ at: 0 })],
    ["no at", (root) => ({ root })],
    ["a negative at", (root) => ({ root, at: -1 })],
    ["an at that is not a whole number", (root) => ({ root, at: 1.5 })],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key(ed25519));
    await expect(readFrom(written(data({ $link: root.link })), root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("is refused when it is written to a schema that is not an identity schema", async () => {
    const other = keys.encode(key(ed25519));
    await expect(readFrom(other.bytes)).rejects.toThrow(`${other.schema.link} is not a schema read here`);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key(ed25519), 0);
    const other = identities.encode(key(ed25519, 2), 0);
    const signed = unsignedOf(identity.link);
    const reader = new Map([
      [linkOf(signed), signed],
      [identity.link, other.bytes],
    ]);
    await expect(signedIdentities.read(linkOf(signed), reader)).rejects.toThrow(/another blob/);
  });
});

describe("a signed identity", () => {
  const readSignedFrom = (bytes: Uint8Array, ...blobs: readonly Uint8Array[]) =>
    signedIdentities.read(linkOf(bytes), byLink([bytes, ...blobs]));
  const signedBy = async (by: SoftwareSigner, identity = identities.encode(by.key, 0)) => ({
    identity: { $link: identity.link },
    signature: bytesToHex(await by.sign(digestOf(identity.link))),
  });

  it.each(schemes)("published by a $name root reads back from its blobs with its identity", async (scheme) => {
    const signed = await publish(signer(scheme), 1_000);
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.link).toBe(signed.link);
    expect(read.identity).toEqual(identities.encode(key(scheme), 1_000));
    expect(isSameKey(read.identity.root, key(scheme))).toBe(true);
    expect(read.signature).toEqual(signed.signature);
  });

  it("carries as its blobs its object, its schema's blobs, and its identity's", async () => {
    const signed = await publish(signer(ed25519));
    const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
    expect(signed.blobs.map((bytes) => linkOf(bytes))).toEqual([
      signed.link,
      schema.link,
      jsonSchema.link,
      ...signed.identity.blobs.map((bytes) => linkOf(bytes)),
    ]);
  });

  it.each(schemes)("published by a $name root carries its closure as its blobs, and nothing else", async (scheme) => {
    const signed = await publish(signer(scheme));
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("is refused when another key signed it", async () => {
    const identity = identities.encode(key(ed25519), 0);
    const bytes = writtenSigned(await signedBy(signer(ed25519, 2), identity));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused when it names another identity than its root signed", async () => {
    const other = identities.encode(key(ed25519, 2), 0);
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
    const identity = identities.encode(key(ed25519), 0);
    const bytes = writtenSigned(change(await signedBy(signer(ed25519))));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/does not fit/);
  });
});

describe.each([
  ["an Identity", (at?: number) => publish(signer(ed25519), at)],
  ["a Delegated Identity", (at?: number) => delegate(signer(ed25519), [], at)],
])("%s its root signs", (_, signed) => {
  it("is at the time it is given", async () => {
    const { identity } = await signed(1_767_225_600_000);
    expect(identity.data.at).toBe(1_767_225_600_000);
  });

  it("is at the time of the clock when it is given none", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z"), toFake: ["Date"] });
    try {
      const { identity } = await signed();
      expect(identity.data.at).toBe(Date.parse("2026-10-30T12:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a Delegated Identity", () => {
  const distinctKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const secretKey = new Uint8Array(32).fill(9);
      new DataView(secretKey.buffer).setUint16(30, i);
      return SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    });
  const agentsOf = (identity: IdentityObject) => (identity as DelegatedIdentityObject).agents;
  const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));

  it("reads back from its blobs with its root and its agents, in the order its root lists them", async () => {
    const agents = [key(ed25519, 3), key(solanaOffchain, 2), key(eip191, 4)];
    const signed = await delegate(signer(eip191), agents);
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.identity).toEqual(signed.identity);
    expect(isSameKey(read.identity.root, key(eip191))).toBe(true);
    expect(agentsOf(read.identity).map(({ link }) => link)).toEqual(agents.map((agent) => keys.encode(agent).link));
  });

  it("has its agents sign for it, and its root only where it lists itself, as it is read", async () => {
    const signed = await delegate(signer(ed25519), [key(ed25519, 2)]);
    const { identity } = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(hasSigner(identity, keys.encode(key(ed25519, 2)))).toBe(true);
    expect(hasSigner(identity, identity.root)).toBe(false);
  });

  it("names its root and its agents by the links of their objects", async () => {
    const { identity } = await delegate(signer(ed25519), [key(ed25519, 2)], 1_000);
    expect(identity.data).toEqual({
      root: { $link: keys.encode(key(ed25519)).link },
      agents: [{ $link: keys.encode(key(ed25519, 2)).link }],
      at: 1_000,
    });
  });

  it("is another identity than its root's Identity, of the same root", async () => {
    const { identity } = await delegate(signer(ed25519), [key(ed25519, 2)]);
    const own = identities.encode(key(ed25519), 0);
    expect(identity.link).not.toBe(own.link);
    expect(identity.root.link).toBe(own.root.link);
  });

  it.each<[string, SoftwareSigner, Key[]]>([
    ["that lists its root among its agents", signer(ed25519), [key(ed25519, 2), key(ed25519)]],
    ["whose agents sign in another scheme than its root", signer(eip191), [key(ed25519, 2), key(ed25519, 3)]],
  ])("%s carries each blob in its closure once, and nothing else", async (_, root, agents) => {
    const signed = await delegate(root, agents);
    const links = linksOf(signed.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("carries as its blobs its object, its keys', and the blobs of the schemas they are written to, each once", async () => {
    const { identity } = await delegate(signer(eip191), [key(ed25519, 2), key(ed25519, 3)]);
    const schema = await encodeSchema(delegatedIdentitySchema, defaultValidator);
    const keyScheme = await encodeSchema(schemeSchema, defaultValidator);
    const [first, second] = agentsOf(identity);
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

  it("is refused when an agent is not a key", async () => {
    const root = keys.encode(key(ed25519));
    const other = identities.encode(key(ed25519, 2), 0);
    const data = { root: { $link: root.link }, agents: [{ $link: other.link }], at: 0 };
    const bytes = json.encode(json.object(data, delegatedIdentities.schema.link));
    await expect(readFrom(bytes, root.bytes, other.bytes)).rejects.toThrow(
      `${other.schema.link} is not a schema read here`,
    );
  });

  it.each<[string, JsonObject]>([
    ["no at", {}],
    ["a negative at", { at: -1 }],
    ["an at that is not a whole number", { at: 1.5 }],
  ])("is refused with %s", async (_, at) => {
    const root = keys.encode(key(ed25519));
    const data = { root: { $link: root.link }, agents: [], ...at };
    const bytes = json.encode(json.object(data, delegatedIdentities.schema.link));
    await expect(readFrom(bytes, root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("can list no agents", async () => {
    const signed = await delegate(signer(ed25519), []);
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(agentsOf(read.identity)).toEqual([]);
  });

  it("can list 256 agents", async () => {
    const signed = await delegate(signer(ed25519), distinctKeys(256));
    expect(agentsOf(signed.identity)).toHaveLength(256);
  });

  it.each<[string, Key[]]>([
    ["one agent twice", [key(ed25519, 2), key(ed25519, 3), key(ed25519, 2)]],
    ["257 agents", distinctKeys(257)],
  ])("with %s is refused before its root is asked to sign", async (_, agents) => {
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(delegate({ key: key(ed25519), sign }, agents)).rejects.toThrow(/does not fit/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("the version of a signed identity", () => {
  it.each([
    ["an Identity", () => publish(signer(ed25519), 1_000)],
    ["a Delegated Identity", () => delegate(signer(ed25519), [key(ed25519, 2)], 1_000)],
  ])("is the root, the at and the link of %s", async (_, signed) => {
    const signedIdentity = await signed();
    expect(versions.versionOf(signedIdentity)).toEqual([signedIdentity.identity.root.link, 1_000, signedIdentity.link]);
  });
});

describe("the selection of versions", () => {
  const { selection } = versions;
  const root = signer(ed25519, 4);

  it.each([
    ["an Identity", () => publish(root, 1_000)],
    ["a Delegated Identity", () => delegate(root, [key(ed25519, 2)], 1_000)],
  ])("reads the signed identity of %s as its version", async (_, signed) => {
    const signedIdentity = await signed();
    expect(await selection.read(signedIdentity.link, byLink(signedIdentity.blobs))).toEqual(
      versions.versionOf(signedIdentity),
    );
  });

  it("leaves out a signed identity that another key signed", async () => {
    const { identity, blobs } = await publish(root, 1_000);
    const forged = writtenSigned({
      identity: { $link: identity.link },
      signature: bytesToHex(await signer(ed25519, 9).sign(digestOf(identity.link))),
    });
    expect(await selection.read(linkOf(forged), byLink([forged, ...blobs]))).toBeUndefined();
  });

  it("leaves out a signed identity that names what is not an identity", async () => {
    const rootKey = keys.encode(root.key);
    const signed = unsignedOf(rootKey.link);
    expect(await selection.read(linkOf(signed), byLink([signed, rootKey.bytes]))).toBeUndefined();
  });

  it("leaves out a signed identity whose root's scheme the application does not accept", async () => {
    const { versions: ed25519Versions } = await loadIdentity(defaultValidator, [ed25519]);
    const signedIdentity = await publish(signer(eip191), 1_000);
    expect(await ed25519Versions.selection.read(signedIdentity.link, byLink(signedIdentity.blobs))).toBeUndefined();
  });

  it("leaves out a signed identity whose identity the reader does not give", async () => {
    const signedIdentity = await publish(root, 1_000);
    const failing = {
      get: async (link: Link<unknown>) => {
        if (link === signedIdentity.link) return signedIdentity.bytes;
        throw new Error("the disk failed");
      },
    };
    expect(await selection.read(signedIdentity.link, byLink([signedIdentity.bytes]))).toBeUndefined();
    expect(await selection.read(signedIdentity.link, failing)).toBeUndefined();
  });

  it("leaves out an object of another schema", async () => {
    const rootKey = keys.encode(root.key);
    expect(await selection.read(rootKey.link, byLink([rootKey.bytes]))).toBeUndefined();
  });
});

describe("the versions a reader has seen", () => {
  const wallet = signer(eip191);
  const blobsOf = (...signed: { readonly blobs: readonly Uint8Array[] }[]) =>
    byLink(signed.flatMap(({ blobs }) => blobs));
  const peopleHavingSeen = (...signed: SignedIdentityObject[]) =>
    versions.people(rowsOf(versions, ...signed), blobsOf(...signed));

  it("give as current the version of a root with the greatest at", async () => {
    const later = await delegate(wallet, [key(ed25519, 2)], 2_000);
    const earlier = await delegate(wallet, [key(ed25519, 3)], 1_000);
    expect((await peopleHavingSeen(later, earlier).current(earlier)).link).toBe(later.link);
  });

  it("give as current of two versions at the same at that whose signed identity has the greater link", async () => {
    const [one, other] = await Promise.all([
      delegate(wallet, [key(ed25519, 2)], 1_000),
      delegate(wallet, [key(ed25519, 3)], 1_000),
    ]);
    const greater = one.link > other.link ? one : other;
    const lesser = greater === one ? other : one;
    expect((await peopleHavingSeen(lesser, greater).current(lesser)).link).toBe(greater.link);
    expect((await peopleHavingSeen(lesser).current(greater)).link).toBe(greater.link);
  });

  it("give the version given as current when it is later than any of them", async () => {
    const earlier = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const later = await delegate(wallet, [key(ed25519, 3)], 2_000);
    expect((await peopleHavingSeen(earlier).current(later)).link).toBe(later.link);
  });

  it("give the version given as current when none of them is of its root", async () => {
    const signed = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const other = await delegate(signer(ed25519, 4), [key(ed25519, 2)], 2_000);
    expect((await peopleHavingSeen(other).current(signed)).link).toBe(signed.link);
  });

  it("give as current the latest version, whichever identity schema each is written to", async () => {
    const published = await publish(wallet, 1_000);
    const delegated = await delegate(wallet, [key(ed25519, 2)], 2_000);
    const republished = await publish(wallet, 3_000);
    expect((await peopleHavingSeen(delegated).current(published)).link).toBe(delegated.link);
    expect((await peopleHavingSeen(published, republished).current(delegated)).link).toBe(republished.link);
  });
});
