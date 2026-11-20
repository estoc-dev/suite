import {
  AbsentBlob,
  decodeObject,
  digestOf,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { bytes, link, rootSchema, schema } from "@estoc/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
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
  SoftwareSigner,
  signedIdentitySchema,
  solanaOffchain,
} from "../src/index.ts";
import { byLink, bytesOf, closure, dataOf, freshKit, schemaLinkOf, schemes } from "./fixtures.ts";

const { keys, identities, signedIdentities, publish } = loadIdentity(schemes);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const written = (data: ValueMap) => objectFormat.encode(new ObjectValue(identities.schema.link, data));
const writtenSigned = (data: ValueMap) => objectFormat.encode(new ObjectValue(signedIdentities.schema.link, data));
// A signed identity's identity is read before its root's signature is
// verified, so one that names an identity that does not read is refused for
// the identity, whatever its signature.
const unsignedOf = (identity: Link<unknown>) =>
  writtenSigned({ identity: new LinkValue(identity), signature: new Uint8Array() });
const readFrom = (bytes: Uint8Array, ...blobs: Uint8Array[]) => {
  const signedIdentityBytes = unsignedOf(linkOf(bytes));
  return signedIdentities.read(linkOf(signedIdentityBytes), byLink([signedIdentityBytes, bytes, ...blobs]));
};
// The link and the bytes of a signed identity of `data`, written as an identity and signed by `root`.
const signedFrom = async (root: SoftwareSigner, data: ValueMap) => {
  const bytes = written(data);
  const signedIdentityBytes = writtenSigned({
    identity: new LinkValue(linkOf(bytes)),
    signature: await root.sign(digestOf(linkOf(bytes))),
  });
  return { link: linkOf(signedIdentityBytes), blobs: [signedIdentityBytes, bytes] };
};
const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));

describe("an identity", () => {
  it("names its root by the link of the root's object, and holds its agents and its at", () => {
    const identity = identities.encode(key(ed25519), { at: 1_000 });
    expect(dataOf(identity)).toEqual({
      root: new LinkValue(keys.encode(key(ed25519)).link),
      agents: [],
      at: 1_000,
    });
    expect(identity.at).toBe(1_000);
  });

  it("has the link of its root as its identifier", () => {
    const identity = identities.encode(key(ed25519), { at: 1_000 });
    expect(identity.identifier).toBe(identity.root.link);
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key(ed25519);
    const plain = identities.encode({ scheme: ed25519, publicKey }, { at: 0 });
    const solana = identities.encode({ scheme: solanaOffchain, publicKey }, { at: 0 });
    expect(schemaLinkOf(plain)).toBe(schemaLinkOf(solana));
    expect(plain.link).not.toBe(solana.link);
  });

  it("has its root and its agents sign for it, and no other key, as it is read", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2)] });
    const { identity } = await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs));
    expect(hasSigner(identity, identity.root)).toBe(true);
    expect(hasSigner(identity, keys.encode(key(ed25519, 2)))).toBe(true);
    expect(hasSigner(identity, keys.encode(key(ed25519, 3)))).toBe(false);
  });

  it("carries as its blobs its object, its root's, and the closures of their schemas, each once", async () => {
    const identity = identities.encode(key(eip191), { at: 0 });
    expect(linksOf(identity.blobs)).toEqual([
      identity.link,
      identitySchema.link,
      rootSchema.link,
      identity.root.link,
      schemaLinkOf(identity.root),
    ]);
  });

  it("is refused without the blob of its root", async () => {
    await expect(readFrom(bytesOf(identities.encode(key(ed25519), { at: 0 })))).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key(ed25519), { at: 0 });
    await expect(
      readFrom(written({ root: new LinkValue(other.link), agents: [], at: 0 }), bytesOf(other)),
    ).rejects.toThrow(`${identitySchema.link} is not a schema read here`);
  });

  it.each<[string, (root: LinkValue<unknown>) => ValueMap]>([
    ["a field besides prior, root, agents, crisis and at", (root) => ({ root, agents: [], at: 0, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.link as string, agents: [], at: 0 })],
    ["no root", () => ({ agents: [], at: 0 })],
    ["no agents", (root) => ({ root, at: 0 })],
    ["no at", (root) => ({ root, agents: [] })],
    ["an at that is a string", (root) => ({ root, agents: [], at: "0" })],
    ["crisis set to a string", (root) => ({ root, agents: [], crisis: "true", at: 0 })],
    ["its prior as a bare string", (root) => ({ prior: root.link as string, root, agents: [], at: 0 })],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key(ed25519));
    await expect(readFrom(written(data(new LinkValue(root.link))), ...root.blobs)).rejects.toThrow(/does not fit/);
  });

  it("is refused with crisis set to false, which leaving it out says", async () => {
    const root = keys.encode(key(ed25519));
    const bytes = written({ root: new LinkValue(root.link), agents: [], crisis: false, at: 0 });
    await expect(readFrom(bytes, ...root.blobs)).rejects.toThrow(/marks a crisis with true, or not at all/);
  });

  it("is refused when it is written to another schema", async () => {
    const other = keys.encode(key(ed25519));
    await expect(readFrom(bytesOf(other))).rejects.toThrow(`the object is written to ${schemaLinkOf(other)}`);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const signedIdentityBytes = unsignedOf(identity.link);
    const reader = new Map([
      [linkOf(signedIdentityBytes), signedIdentityBytes],
      [identity.link, bytesOf(other)],
    ]);
    await expect(signedIdentities.read(linkOf(signedIdentityBytes), reader)).rejects.toThrow(/another blob/);
  });

  it("is a crisis when its root marks it as one, and holds no crisis otherwise", () => {
    const crisis = identities.encode(key(ed25519), { isCrisis: true, at: 0 });
    const plain = identities.encode(key(ed25519), { at: 0 });
    expect(crisis.isCrisis).toBe(true);
    expect(dataOf(crisis).crisis).toBe(true);
    expect(plain.isCrisis).toBe(false);
    expect(dataOf(plain)).not.toHaveProperty("crisis");
  });
});

describe("a signed identity", () => {
  const readSignedFrom = (bytes: Uint8Array, ...blobs: readonly Uint8Array[]) =>
    signedIdentities.read(linkOf(bytes), byLink([bytes, ...blobs]));
  const signedBy = async (by: SoftwareSigner, identity = identities.encode(by.key, { at: 0 })) => ({
    identity: new LinkValue(identity.link),
    signature: await by.sign(digestOf(identity.link)),
  });

  it("is refused by verify when it is written to another schema", async () => {
    const otherSchema: Schema<SignedIdentityData> = schema("Another", {
      identity: link(),
      signature: bytes(),
    });
    const by = signer(ed25519);
    const object = encodeObject(otherSchema, await signedBy(by));
    await expect(signedIdentities.verify(object, byLink(identities.encode(by.key, { at: 0 }).blobs))).rejects.toThrow(
      /a signed identity is written to/,
    );
  });

  it.each(schemes)("published by a $name root reads back from its blobs with its identity", async (scheme) => {
    const signedIdentity = await publish(signer(scheme), { at: 1_000 });
    const read = await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs));
    expect(read.link).toBe(signedIdentity.link);
    expect(read.identity).toEqual(identities.encode(key(scheme), { at: 1_000 }));
    expect(isSameKey(read.identity.root, key(scheme))).toBe(true);
    expect(read.signature).toEqual(signedIdentity.signature);
  });

  it("carries as its blobs its object, the closure of its schema, and its identity's, each once", async () => {
    const signedIdentity = await publish(signer(ed25519));
    expect(linksOf(signedIdentity.blobs)).toEqual([
      signedIdentity.link,
      signedIdentitySchema.link,
      rootSchema.link,
      ...linksOf(signedIdentity.identity.blobs).filter((link) => link !== rootSchema.link),
    ]);
  });

  it.each(schemes)("published by a $name root carries its closure as its blobs, and nothing else", async (scheme) => {
    const signedIdentity = await publish(signer(scheme));
    const blobs = byLink(signedIdentity.blobs);
    expect(closure(signedIdentity.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("is refused when another key signed it", async () => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const bytes = writtenSigned(await signedBy(signer(ed25519, 2), identity));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused when it names another identity than its root signed", async () => {
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const data = { ...(await signedBy(signer(ed25519))), identity: new LinkValue(other.link) };
    await expect(readSignedFrom(writtenSigned(data), ...other.blobs)).rejects.toThrow(/did not sign/);
  });

  it("is refused without the blobs of its identity", async () => {
    await expect(readSignedFrom(writtenSigned(await signedBy(signer(ed25519))))).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (fields: ValueMap) => ValueMap]>([
    ["a field besides identity and signature", (fields) => ({ ...fields, at: 0 })],
    [
      "its signature in hex, which is a string",
      (fields) => ({ ...fields, signature: bytesToHex(fields.signature as Uint8Array) }),
    ],
    ["no signature", ({ signature: _, ...fields }) => fields],
  ])("is refused with %s", async (_, change) => {
    const identity = identities.encode(key(ed25519), { at: 0 });
    const bytes = writtenSigned(change(await signedBy(signer(ed25519))));
    await expect(readSignedFrom(bytes, ...identity.blobs)).rejects.toThrow(/does not fit/);
  });

  it("is at the time it is given", async () => {
    const { identity } = await publish(signer(ed25519), { at: 1_767_225_600_000 });
    expect(identity.at).toBe(1_767_225_600_000);
  });

  it("is at the time of the clock when it is given none", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z"), toFake: ["Date"] });
    try {
      const { identity } = await publish(signer(ed25519));
      expect(identity.at).toBe(Date.parse("2026-10-30T12:00:00Z"));
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
    const signedIdentity = await publish(signer(eip191), { agents });
    const read = await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs));
    expect(read.identity).toEqual(signedIdentity.identity);
    expect(isSameKey(read.identity.root, key(eip191))).toBe(true);
    expect(read.identity.agents.map(({ link }) => link)).toEqual(agents.map((agent) => keys.encode(agent).link));
  });

  it("are named by the links of their objects", async () => {
    const { identity } = await publish(signer(ed25519), { agents: [key(ed25519, 2)], at: 1_000 });
    expect(dataOf(identity)).toEqual({
      root: new LinkValue(keys.encode(key(ed25519)).link),
      agents: [new LinkValue(keys.encode(key(ed25519, 2)).link)],
      at: 1_000,
    });
  });

  it("make another identity of the same root, and of the same someone", async () => {
    const { identity } = await publish(signer(ed25519), { agents: [key(ed25519, 2)], at: 0 });
    const own = identities.encode(key(ed25519), { at: 0 });
    expect(identity.link).not.toBe(own.link);
    expect(identity.root.link).toBe(own.root.link);
    expect(identity.identifier).toBe(own.identifier);
  });

  it("in another scheme than the root are carried with each blob of the closure once, and nothing else", async () => {
    const signedIdentity = await publish(signer(eip191), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const links = linksOf(signedIdentity.identity.blobs);
    expect(new Set(links).size).toBe(links.length);
    const blobs = byLink(signedIdentity.blobs);
    expect(closure(signedIdentity.link, blobs)).toEqual(new Set(blobs.keys()));
  });

  it("are carried with the root and the closures of their schemas, each once", async () => {
    const { identity } = await publish(signer(eip191), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const [first, second] = identity.agents;
    assert.exists(first);
    assert.exists(second);
    expect(linksOf(identity.blobs)).toEqual([
      identity.link,
      identitySchema.link,
      rootSchema.link,
      identity.root.link,
      schemaLinkOf(identity.root),
      first.link,
      schemaLinkOf(first),
      second.link,
    ]);
  });

  it("are refused when one is not a key", async () => {
    const root = keys.encode(key(ed25519));
    const other = identities.encode(key(ed25519, 2), { at: 0 });
    const bytes = written({ root: new LinkValue(root.link), agents: [new LinkValue(other.link)], at: 0 });
    await expect(readFrom(bytes, ...root.blobs, bytesOf(other))).rejects.toThrow(
      `${identitySchema.link} is not a schema read here`,
    );
  });

  it("are refused when they list the root", async () => {
    const root = keys.encode(key(ed25519));
    const bytes = written({ root: new LinkValue(root.link), agents: [new LinkValue(root.link)], at: 0 });
    await expect(readFrom(bytes, ...root.blobs)).rejects.toThrow(/lists its root as an agent/);
  });

  it("are refused when they list one of them twice", async () => {
    const root = keys.encode(key(ed25519));
    const agent = keys.encode(key(ed25519, 2));
    const agents = [new LinkValue(agent.link), new LinkValue(agent.link)];
    const bytes = written({ root: new LinkValue(root.link), agents, at: 0 });
    await expect(readFrom(bytes, ...root.blobs, ...agent.blobs)).rejects.toThrow(/lists an agent twice/);
  });

  it("can be none", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [] });
    const read = await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs));
    expect(read.identity.agents).toEqual([]);
  });

  it("can be 255", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: distinctKeys(255) });
    expect(signedIdentity.identity.agents).toHaveLength(255);
  });

  it.each<[string, Key[], RegExp]>([
    ["one agent twice", [key(ed25519, 2), key(ed25519, 3), key(ed25519, 2)], /lists an agent twice/],
    ["256 agents", distinctKeys(256), /lists more than 255 agents/],
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
    expect(dataOf(second.identity).prior).toEqual(new LinkValue(first.link));
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
    const signedIdentity = await signedFrom(by, {
      prior: new LinkValue(prior.link),
      root: new LinkValue(rootKey.link),
      agents: [],
      at,
    });
    const reader = byLink([...signedIdentity.blobs, ...rootKey.blobs, ...prior.blobs]);
    await expect(signedIdentities.read(signedIdentity.link, reader)).rejects.toThrow(error);
  });

  it("is refused without the blobs of the identity version it follows", async () => {
    const first = await publish(root, { at: 1_000 });
    const second = await publish(root, { prior: first, at: 2_000 });
    const without = second.blobs.filter((bytes) => linkOf(bytes) !== first.link);
    await expect(freshKit().signedIdentities.read(second.link, byLink(without))).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root did not sign the identity version it follows", async () => {
    const first = await publish(root, { at: 1_000 });
    const forged = writtenSigned({
      identity: new LinkValue(first.identity.link),
      signature: await signer(eip191, 9).sign(digestOf(first.identity.link)),
    });
    const rootKey = keys.encode(root.key);
    const second = await signedFrom(root, {
      prior: new LinkValue(linkOf(forged)),
      root: new LinkValue(rootKey.link),
      agents: [],
      at: 2_000,
    });
    await expect(signedIdentities.read(second.link, byLink([...second.blobs, forged, ...first.blobs]))).rejects.toThrow(
      /did not sign/,
    );
  });
});

describe("the implementation of the signed identity schema", () => {
  const { implementation } = signedIdentities;
  const root = signer(ed25519, 4);
  const read = async (bytes: Uint8Array, blobs: readonly Uint8Array[], by = implementation) =>
    by.read(decodeObject(bytes, by.schema), byLink(blobs));

  it("reads a signed identity as verifying it does", async () => {
    const signedIdentity = await publish(root, { prior: await publish(root, { at: 500 }), at: 1_000 });
    const object = decodeObject(bytesOf(signedIdentity), signedIdentities.schema);
    expect(await read(bytesOf(signedIdentity), signedIdentity.blobs)).toEqual(
      await signedIdentities.verify(object, byLink(signedIdentity.blobs)),
    );
  });

  it("refuses a signed identity that another key signed", async () => {
    const { identity, blobs } = await publish(root, { at: 1_000 });
    const forgedBytes = writtenSigned({
      identity: new LinkValue(identity.link),
      signature: await signer(ed25519, 9).sign(digestOf(identity.link)),
    });
    await expect(read(forgedBytes, blobs)).rejects.toThrow(/did not sign/);
  });

  it("refuses a signed identity without the blob of its identity, by an error that has its link", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const error = await read(bytesOf(signedIdentity), [], freshKit().signedIdentities.implementation).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AbsentBlob);
    expect(error).toHaveProperty("link", signedIdentity.identity.link);
  });
});

describe("signed identities", () => {
  const root = signer(ed25519, 5);
  afterEach(() => vi.restoreAllMocks());

  it("give a signed identity they have read again, without asking the reader or verifying it again", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const { signedIdentities } = freshKit();
    const read = await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs));
    const verify = vi.spyOn(ed25519, "verify");
    expect(await signedIdentities.read(signedIdentity.link, new Map())).toEqual(read);
    expect(verify).not.toHaveBeenCalled();
  });

  it("give a signed identity they signed without asking the reader", async () => {
    const { signedIdentities, publish } = freshKit();
    const signedIdentity = await publish(root, { at: 1_000 });
    expect(await signedIdentities.read(signedIdentity.link, new Map())).toEqual(signedIdentity);
  });

  it("read an identity version that follows one they have read, verifying its own signature alone", async () => {
    const first = await publish(root, { at: 1_000 });
    const second = await publish(root, { prior: first, at: 2_000 });
    const { signedIdentities } = freshKit();
    await signedIdentities.read(first.link, byLink(first.blobs));
    const verify = vi.spyOn(ed25519, "verify");
    const without = second.blobs.filter((bytes) => linkOf(bytes) !== first.link);
    expect(await signedIdentities.read(second.link, byLink(without))).toEqual(second);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("read a signed identity they were refused for a blob the reader did not give, once a reader gives it", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const { signedIdentities } = freshKit();
    await expect(signedIdentities.read(signedIdentity.link, byLink([bytesOf(signedIdentity)]))).rejects.toThrow(
      AbsentBlob,
    );
    expect(await signedIdentities.read(signedIdentity.link, byLink(signedIdentity.blobs))).toEqual(signedIdentity);
  });
});
