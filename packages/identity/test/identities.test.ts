import { digestOf, encodeSchema, type Json, type JsonObject, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assert, describe, expect, it, test, vi } from "vitest";
import {
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  type IdentityObject,
  identityInterface,
  identitySchema,
  type Key,
  keyInterface,
  keySchemas,
  loadIdentities,
  type Scheme,
  SoftwareSigner,
  sameKey,
  signedIdentitySchema,
} from "../src/index.ts";

const identities = await loadIdentities(defaultValidator);
const { keys } = identities;
const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: Scheme, fill = 1) => signer(scheme, fill).key;
const written = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(identitySchema))));
const readFrom = (bytes: Uint8Array, ...blobs: Uint8Array[]) =>
  identities.read(linkOf(bytes), byLink([bytes, ...blobs]));

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
  it.each(["ed25519", "eip191", "solana-offchain"] as const)(
    "with a %s root reads back from its blobs with its root",
    async (scheme) => {
      const identity = identities.encode(key(scheme));
      const read = await identities.read(identity.link, byLink(identity.blobs));
      expect(read.link).toBe(identity.link);
      expect(read.root.link).toBe(identity.root.link);
      expect(sameKey(read.root, key(scheme))).toBe(true);
    },
  );

  it("names its root by the link of the root's object", () => {
    const identity = identities.encode(key("ed25519"));
    expect(identity.data).toEqual({ root: { $link: keys.encode(key("ed25519")).link } });
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key("ed25519");
    const plain = identities.encode({ scheme: "ed25519", publicKey });
    const solana = identities.encode({ scheme: "solana-offchain", publicKey });
    expect(plain.schema.link).toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("carries as its blobs its object, its root's, the schemas they are written to and the interfaces those name", async () => {
    const identity = identities.encode(key("eip191"));
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keySchema = await encodeSchema(keySchemas.eip191, defaultValidator);
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
    await expect(readFrom(identities.encode(key("ed25519")).bytes)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key("ed25519"));
    await expect(readFrom(written({ root: { $link: other.link } }), other.bytes)).rejects.toThrow(
      /no scheme writes its keys to/,
    );
  });

  it.each<[string, (root: JsonObject) => JsonObject]>([
    ["a field besides root", (root) => ({ root, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.$link as string })],
    ["no root", () => ({})],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key("ed25519"));
    await expect(readFrom(written(data({ $link: root.link })), root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("is refused when it is written to a schema that is not an identity schema", async () => {
    await expect(readFrom(keys.encode(key("ed25519")).bytes)).rejects.toThrow(/not written to an identity schema/);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key("ed25519"));
    const other = identities.encode(key("ed25519", 2));
    await expect(identities.read(identity.link, new Map([[identity.link, other.bytes]]))).rejects.toThrow(
      /another blob/,
    );
  });
});

describe("a signed identity", () => {
  const writtenSigned = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(signedIdentitySchema))));
  const readSignedFrom = (bytes: Uint8Array, ...blobs: readonly Uint8Array[]) =>
    identities.readSigned(linkOf(bytes), byLink([bytes, ...blobs]));
  const signedBy = async (by: SoftwareSigner, identity = identities.encode(by.key)) => ({
    identity: { $link: identity.link },
    signature: bytesToHex(await by.sign(digestOf(identity.link))),
  });

  it.each(["ed25519", "eip191", "solana-offchain"] as const)(
    "published by a %s root reads back from its blobs with its identity",
    async (scheme) => {
      const signed = await identities.publish(signer(scheme));
      const read = await identities.readSigned(signed.link, byLink(signed.blobs));
      expect(read.link).toBe(signed.link);
      expect(read.identity).toEqual(identities.encode(key(scheme)));
      expect(read.signature).toEqual(signed.signature);
    },
  );

  it("carries as its blobs its object, its schema, and its identity's blobs", async () => {
    const signed = await identities.publish(signer("ed25519"));
    const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
    expect(signed.blobs.map((bytes) => linkOf(bytes))).toEqual([
      signed.link,
      schema.link,
      ...signed.identity.blobs.map((bytes) => linkOf(bytes)),
    ]);
  });

  it.each(["ed25519", "eip191", "solana-offchain"] as const)(
    "published by a %s root carries as its blobs all it leads to and nothing else",
    async (scheme) => {
      const signed = await identities.publish(signer(scheme));
      const blobs = byLink(signed.blobs);
      expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
    },
  );

  it("is refused when another key signed it", async () => {
    const identity = identities.encode(key("ed25519"));
    const bytes = writtenSigned(await signedBy(signer("ed25519", 2), identity));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused when it names another identity than its root signed", async () => {
    const other = identities.encode(key("ed25519", 2));
    const data = { ...(await signedBy(signer("ed25519"))), identity: { $link: other.link } };
    await expect(readSignedFrom(writtenSigned(data), ...other.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused without the blobs of its identity", async () => {
    await expect(readSignedFrom(writtenSigned(await signedBy(signer("ed25519"))))).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (signed: JsonObject) => JsonObject]>([
    ["a field besides identity and signature", (signed) => ({ ...signed, at: 0 })],
    ["its signature in uppercase hex", (signed) => ({ ...signed, signature: String(signed.signature).toUpperCase() })],
    ["no signature", ({ signature: _, ...signed }) => signed],
  ])("is refused with %s", async (_, change) => {
    const identity = identities.encode(key("ed25519"));
    const bytes = writtenSigned(change(await signedBy(signer("ed25519"))));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/does not fit/);
  });
});

describe("a Delegated Identity", () => {
  const distinctKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const secretKey = new Uint8Array(32).fill(9);
      new DataView(secretKey.buffer).setUint16(30, i);
      return SoftwareSigner.fromSecretKey("ed25519", secretKey).key;
    });
  const agentsOf = (identity: IdentityObject) => (identity as DelegatedIdentityObject).agents;
  const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));

  it("reads back from its blobs with its root and its agents, in the order its root lists them", async () => {
    const agents = [key("ed25519", 3), key("solana-offchain", 2), key("eip191", 4)];
    const signed = await identities.delegate(signer("eip191"), agents);
    const read = await identities.readSigned(signed.link, byLink(signed.blobs));
    expect(read.identity).toEqual(signed.identity);
    expect(sameKey(read.identity.root, key("eip191"))).toBe(true);
    expect(agentsOf(read.identity).map(({ link }) => link)).toEqual(agents.map((agent) => keys.encode(agent).link));
  });

  it("names its root and its agents by the links of their objects", async () => {
    const { identity } = await identities.delegate(signer("ed25519"), [key("ed25519", 2)]);
    expect(identity.data).toEqual({
      root: { $link: keys.encode(key("ed25519")).link },
      agents: [{ $link: keys.encode(key("ed25519", 2)).link }],
    });
  });

  it("is another identity than its root's Identity, of the same root", async () => {
    const { identity } = await identities.delegate(signer("ed25519"), [key("ed25519", 2)]);
    const own = identities.encode(key("ed25519"));
    expect(identity.link).not.toBe(own.link);
    expect(identity.root.link).toBe(own.root.link);
  });

  it.each<[string, SoftwareSigner, Key[]]>([
    ["that lists its root among its agents", signer("ed25519"), [key("ed25519", 2), key("ed25519")]],
    ["whose agents sign in another scheme than its root", signer("eip191"), [key("ed25519", 2), key("ed25519", 3)]],
  ])("%s carries each blob it leads to once, and nothing else", async (_, root, agents) => {
    const signed = await identities.delegate(root, agents);
    const links = linksOf(signed.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    const blobs = byLink(signed.blobs);
    expect(closure(signed.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("carries as its blobs its object, its keys', the schemas they are written to and the interfaces those name", async () => {
    const { identity } = await identities.delegate(signer("eip191"), [key("ed25519", 2), key("ed25519", 3)]);
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
    const root = keys.encode(key("ed25519"));
    const other = identities.encode(key("ed25519", 2));
    const data = { root: { $link: root.link }, agents: [{ $link: other.link }] };
    const bytes = json.encode(json.object(data, linkOf(json.encode(delegatedIdentitySchema))));
    await expect(readFrom(bytes, root.bytes, other.bytes)).rejects.toThrow(/no scheme writes its keys to/);
  });

  it("can list no agents", async () => {
    const signed = await identities.delegate(signer("ed25519"), []);
    const read = await identities.readSigned(signed.link, byLink(signed.blobs));
    expect(agentsOf(read.identity)).toEqual([]);
  });

  it("can list 256 agents", async () => {
    const signed = await identities.delegate(signer("ed25519"), distinctKeys(256));
    expect(agentsOf(signed.identity)).toHaveLength(256);
  });

  it.each<[string, Key[]]>([
    ["one agent twice", [key("ed25519", 2), key("ed25519", 3), key("ed25519", 2)]],
    ["257 agents", distinctKeys(257)],
  ])("with %s is refused before its root is asked to sign", async (_, agents) => {
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(identities.delegate({ key: key("ed25519"), sign }, agents)).rejects.toThrow(/does not fit/);
    expect(sign).not.toHaveBeenCalled();
  });
});
