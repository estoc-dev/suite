import { digestOf, encodeSchema, type Json, type JsonObject, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assert, describe, expect, it, test, vi } from "vitest";
import {
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  ed25519,
  eip191,
  type IdentityObject,
  identityInterface,
  identitySchema,
  type Key,
  keyInterface,
  loadIdentity,
  type Scheme,
  type SignedIdentityObject,
  SoftwareSigner,
  sameKey,
  signedIdentitySchema,
  solanaOffchain,
  type Version,
} from "../src/index.ts";
import { rowsOf, schemes } from "./fixtures.ts";

const { keys, identities, signedIdentities, versions, publish, delegate } = await loadIdentity(defaultValidator);
const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: Scheme, fill = 1) => signer(scheme, fill).key;
const written = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(identitySchema))));
const writtenSigned = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(signedIdentitySchema))));
// A signed identity's identity is read before its root's signature is
// verified, so one that names an identity that does not read is refused for
// the identity, whatever its signature.
const unsignedOf = (identity: Link<unknown>) => writtenSigned({ identity: { $link: identity }, signature: "" });
const readFrom = (bytes: Uint8Array, ...blobs: Uint8Array[]) => {
  const signed = unsignedOf(linkOf(bytes));
  return signedIdentities.read(linkOf(signed), byLink([signed, bytes, ...blobs]));
};

// The links a store gathers from a blob: every blob it leads to by the links
// JSON finds in it, past which a blob that is not JSON leads nowhere.
function closure(link: Link<unknown>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Set<Link<unknown>> {
  const reached = new Set([link]);
  for (const next of reached) {
    const bytes = blobs.get(next);
    if (bytes === undefined) continue;
    let value: Json;
    try {
      value = json.decode(bytes);
    } catch {
      continue;
    }
    for (const linked of json.links(value)) reached.add(linked);
  }
  return reached;
}

test.each([
  ["Identity", identitySchema],
  ["Delegated Identity", delegatedIdentitySchema],
])("the %s schema names the Identity interface", (_, schema) => {
  expect(schema["x-implements"]).toEqual({ $link: identityInterface.link });
});

describe("an identity", () => {
  it("names its root by the link of the root's object", () => {
    const identity = identities.encode(key(ed25519));
    expect(identity.data).toEqual({ root: { $link: keys.encode(key(ed25519)).link } });
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key(ed25519);
    const plain = identities.encode({ scheme: ed25519, publicKey });
    const solana = identities.encode({ scheme: solanaOffchain, publicKey });
    expect(plain.schema.link).toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("carries as its blobs its object, its root's, the schemas they are written to and the interfaces those name", async () => {
    const identity = identities.encode(key(eip191));
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keySchema = await encodeSchema(eip191.keySchema, defaultValidator);
    expect(identity.blobs.map((bytes) => linkOf(bytes))).toEqual([
      identity.link,
      identity.root.link,
      schema.link,
      keySchema.link,
      identityInterface.link,
      keyInterface.link,
    ]);
  });

  it("is refused without the blob of its root", async () => {
    await expect(readFrom(identities.encode(key(ed25519)).bytes)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key(ed25519));
    await expect(readFrom(written({ root: { $link: other.link } }), other.bytes)).rejects.toThrow(
      `${other.schema.link} is not a schema read here`,
    );
  });

  it.each<[string, (root: JsonObject) => JsonObject]>([
    ["a field besides root", (root) => ({ root, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.$link as string })],
    ["no root", () => ({})],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key(ed25519));
    await expect(readFrom(written(data({ $link: root.link })), root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("is refused when it is written to a schema that is not an identity schema", async () => {
    const other = keys.encode(key(ed25519));
    await expect(readFrom(other.bytes)).rejects.toThrow(`${other.schema.link} is not a schema read here`);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key(ed25519));
    const other = identities.encode(key(ed25519, 2));
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
  const signedBy = async (by: SoftwareSigner, identity = identities.encode(by.key)) => ({
    identity: { $link: identity.link },
    signature: bytesToHex(await by.sign(digestOf(identity.link))),
  });

  it.each(schemes)("published by a $name root reads back from its blobs with its identity", async (scheme) => {
    const signed = await publish(signer(scheme));
    const read = await signedIdentities.read(signed.link, byLink(signed.blobs));
    expect(read.link).toBe(signed.link);
    expect(read.identity).toEqual(identities.encode(key(scheme)));
    expect(sameKey(read.identity.root, key(scheme))).toBe(true);
    expect(read.signature).toEqual(signed.signature);
  });

  it("carries as its blobs its object, its schema, and its identity's blobs", async () => {
    const signed = await publish(signer(ed25519));
    const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
    expect(signed.blobs.map((bytes) => linkOf(bytes))).toEqual([
      signed.link,
      schema.link,
      ...signed.identity.blobs.map((bytes) => linkOf(bytes)),
    ]);
  });

  it.each(schemes)(
    "published by a $name root carries as its blobs all it leads to and nothing else",
    async (scheme) => {
      const signed = await publish(signer(scheme));
      const blobs = byLink(signed.blobs);
      expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
    },
  );

  it("is refused when another key signed it", async () => {
    const identity = identities.encode(key(ed25519));
    const bytes = writtenSigned(await signedBy(signer(ed25519, 2), identity));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused when it names another identity than its root signed", async () => {
    const other = identities.encode(key(ed25519, 2));
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
    const identity = identities.encode(key(ed25519));
    const bytes = writtenSigned(change(await signedBy(signer(ed25519))));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/does not fit/);
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
    expect(sameKey(read.identity.root, key(eip191))).toBe(true);
    expect(agentsOf(read.identity).map(({ link }) => link)).toEqual(agents.map((agent) => keys.encode(agent).link));
  });

  it("names its root and its agents by the links of their objects", async () => {
    const { identity } = await delegate(signer(ed25519), [key(ed25519, 2)], 1_000);
    expect(identity.data).toEqual({
      root: { $link: keys.encode(key(ed25519)).link },
      agents: [{ $link: keys.encode(key(ed25519, 2)).link }],
      at: 1_000,
    });
  });

  it("is at the time it is given", async () => {
    const { identity } = await delegate(signer(ed25519), [], 1_767_225_600_000);
    expect(identity.data.at).toBe(1_767_225_600_000);
  });

  it("is at the time of the clock when it is given none", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z"), toFake: ["Date"] });
    try {
      const { identity } = await delegate(signer(ed25519), []);
      expect(identity.data.at).toBe(Date.parse("2026-10-30T12:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("is another identity than its root's Identity, of the same root", async () => {
    const { identity } = await delegate(signer(ed25519), [key(ed25519, 2)]);
    const own = identities.encode(key(ed25519));
    expect(identity.link).not.toBe(own.link);
    expect(identity.root.link).toBe(own.root.link);
  });

  it.each<[string, SoftwareSigner, Key[]]>([
    ["that lists its root among its agents", signer(ed25519), [key(ed25519, 2), key(ed25519)]],
    ["whose agents sign in another scheme than its root", signer(eip191), [key(ed25519, 2), key(ed25519, 3)]],
  ])("%s carries each blob it leads to once, and nothing else", async (_, root, agents) => {
    const signed = await delegate(root, agents);
    const links = linksOf(signed.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("carries as its blobs its object, its keys', the schemas they are written to and the interfaces those name", async () => {
    const { identity } = await delegate(signer(eip191), [key(ed25519, 2), key(ed25519, 3)]);
    const schema = await encodeSchema(delegatedIdentitySchema, defaultValidator);
    const [first, second] = agentsOf(identity);
    assert.exists(first);
    assert.exists(second);
    expect(linksOf(identity.blobs)).toEqual([
      identity.link,
      identity.root.link,
      first.link,
      second.link,
      schema.link,
      identity.root.schema.link,
      first.schema.link,
      identityInterface.link,
      keyInterface.link,
    ]);
  });

  it("is refused when an agent is not a key", async () => {
    const root = keys.encode(key(ed25519));
    const other = identities.encode(key(ed25519, 2));
    const data = { root: { $link: root.link }, agents: [{ $link: other.link }], at: 0 };
    const bytes = json.encode(json.object(data, linkOf(json.encode(delegatedIdentitySchema))));
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
    const bytes = json.encode(json.object(data, linkOf(json.encode(delegatedIdentitySchema))));
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
  it("is the root, the at and the link of a Delegated Identity's", async () => {
    const signed = await delegate(signer(ed25519), [key(ed25519, 2)], 1_000);
    expect(versions.of(signed)).toEqual([signed.identity.root.link, 1_000, signed.link]);
  });

  it("is undefined for an Identity", async () => {
    expect(versions.of(await publish(signer(ed25519)))).toBeUndefined();
  });
});

describe("the versions a reader knows", () => {
  const wallet = signer(eip191);
  const blobsOf = (...signed: { readonly blobs: readonly Uint8Array[] }[]) =>
    byLink(signed.flatMap(({ blobs }) => blobs));
  const knowing = (...signed: SignedIdentityObject[]) =>
    versions.known(rowsOf(versions, ...signed), blobsOf(...signed));

  it("give as current the version of a root with the greatest at", async () => {
    const later = await delegate(wallet, [key(ed25519, 2)], 2_000);
    const earlier = await delegate(wallet, [key(ed25519, 3)], 1_000);
    expect((await knowing(later, earlier).current(earlier)).link).toBe(later.link);
  });

  it("give as current of two versions at the same at that whose signed identity has the greater link", async () => {
    const [one, other] = await Promise.all([
      delegate(wallet, [key(ed25519, 2)], 1_000),
      delegate(wallet, [key(ed25519, 3)], 1_000),
    ]);
    const greater = one.link > other.link ? one : other;
    const lesser = greater === one ? other : one;
    expect((await knowing(lesser, greater).current(lesser)).link).toBe(greater.link);
    expect((await knowing(lesser).current(greater)).link).toBe(greater.link);
  });

  it("give the version given as current when it is later than they know", async () => {
    const earlier = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const later = await delegate(wallet, [key(ed25519, 3)], 2_000);
    expect((await knowing(earlier).current(later)).link).toBe(later.link);
  });

  it("give the version given as current when they know none of its root", async () => {
    const signed = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const other = await delegate(signer(ed25519, 4), [key(ed25519, 2)], 2_000);
    expect((await knowing(other).current(signed)).link).toBe(signed.link);
  });

  it("give an Identity as its own current version, whatever versions of its root they know", async () => {
    const published = await publish(wallet);
    const version = await delegate(wallet, [key(ed25519, 2)], 1_000);
    expect((await knowing(version).current(published)).link).toBe(published.link);
  });

  it("refuse a row whose signed identity is not of a Delegated Identity", async () => {
    const published = await publish(wallet);
    const version = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const root = published.identity.root.link;
    const rows = {
      async *range(): AsyncIterable<Version> {
        yield [root, 2_000, published.link];
      },
    };
    await expect(versions.known(rows, blobsOf(published, version)).current(version)).rejects.toThrow(
      /is not a version of a Delegated Identity/,
    );
  });
});
