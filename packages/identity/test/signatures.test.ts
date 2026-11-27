import {
  AbsentBlob,
  decodeObject,
  digestOf,
  encodeObject,
  itself,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Reader,
  rootSchema,
  type ValueMap,
} from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  identityKit,
  isSameKey,
  type Signature,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  signatureSchema,
  solanaOffchain,
} from "../src/index.ts";
import {
  byLink as blobsByLink,
  bytesOf,
  dataOf,
  freshKit,
  identityVersionInHand,
  schemaLinkOf,
  schemes,
} from "./fixtures.ts";

const { identities, signatures, publish } = identityKit;
const verified = async (bytes: Uint8Array, blobs: Reader = new Map()) =>
  freshKit().signatures.verify(decodeObject(bytes, signatureSchema), blobs);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const written = (signature: Signature, data: ValueMap) =>
  objectFormat.encode(new ObjectValue(schemaLinkOf(signature), data));
const rewritten = (signature: Signature, change: ValueMap) => written(signature, { ...dataOf(signature), ...change });
const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));
const byLink = (...identities: SignedIdentityObject[]) => blobsByLink(identities.flatMap(({ blobs }) => blobs));
const identityOf = (signature: Signature) => byLink(signature.signedIdentity);
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, { at: 0 }), identityVersionInHand).sign(object);

const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello" });
const goodbye = encodeObject(note, { text: "goodbye" });

describe("a signature", () => {
  it.each(schemes)("by a $name key reads back with its identity and object", async (scheme) => {
    const by = signer(scheme);
    const signature = await sign(hello, by);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(read.signedIdentity).toEqual(signature.signedIdentity);
    expect(read.signedIdentity.identity).toEqual(identities.encode(by.key, { at: 0 }));
    expect(read.object).toBe(hello.link);
    expect(read.signature).toEqual(signature.signature);
    expect(read.link).toBe(signature.link);
  });

  it("is refused when its signature is changed", async () => {
    const signature = await sign(hello, signer(ed25519));
    const changed = signature.signature.map((byte, at, bytes) => (at === bytes.length - 1 ? byte ^ 1 : byte));
    await expect(verified(rewritten(signature, { signature: changed }), identityOf(signature))).rejects.toThrow();
  });

  it("is refused when it names another identity, even the same key in another scheme", async () => {
    const signature = await sign(hello, signer(ed25519));
    for (const other of [await publish(signer(ed25519, 2)), await publish(signer(solanaOffchain))]) {
      await expect(
        verified(rewritten(signature, { signedIdentity: new LinkValue(other.link) }), byLink(other)),
      ).rejects.toThrow(/does not verify/);
    }
  });

  it("is refused when it names another object", async () => {
    const signature = await sign(hello, signer(eip191));
    await expect(
      verified(rewritten(signature, { object: new LinkValue(goodbye.link) }), identityOf(signature)),
    ).rejects.toThrow();
  });

  it("carries as its blobs its object, the closure of its schema, and its signed identity's, each once", async () => {
    const signature = await sign(hello, signer(ed25519));
    expect(linksOf(signature.blobs)).toEqual([
      signature.link,
      signatureSchema.link,
      rootSchema.link,
      ...linksOf(signature.signedIdentity.blobs).filter((link) => link !== rootSchema.link),
    ]);
  });

  it("over a note reads back from its blobs alone, which do not hold the note", async () => {
    const signature = await sign(hello, signer(eip191));
    expect(await freshKit().signatures.read(signature.link, blobsByLink(signature.blobs))).toEqual(signature);
    expect(linksOf(signature.blobs)).not.toContain(hello.link);
  });

  it("is refused without the blobs of its identity", async () => {
    const signature = await sign(hello, signer(ed25519));
    await expect(verified(bytesOf(signature))).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (fields: ValueMap) => ValueMap]>([
    ["its signature in hex, which is a string", (f) => ({ ...f, signature: bytesToHex(f.signature as Uint8Array) })],
    ["its object named by the bytes of its hash, which are no link", (f) => ({ ...f, object: digestOf(hello.link) })],
    ["its object's link as a bare string", (f) => ({ ...f, object: hello.link })],
    ["a field besides signedIdentity, object and signature", (f) => ({ ...f, role: "buyer" })],
    ["no signature", ({ signature: _, ...f }) => f],
    ["its object named by a map that holds its link", (f) => ({ ...f, object: { link: hello.link } })],
    [
      "an identity written in place of the link to its signed identity",
      (f) => ({ ...f, signedIdentity: dataOf(identities.encode(signer(ed25519).key, { at: 0 })) }),
    ],
    [
      "its identity in place of its signed identity",
      (f) => ({ ...f, signedIdentity: new LinkValue(identities.encode(signer(ed25519).key, { at: 0 }).link) }),
    ],
  ])("is refused with %s", async (_, change) => {
    const signature = await sign(hello, signer(ed25519));
    await expect(async () =>
      verified(written(signature, change(dataOf(signature))), identityOf(signature)),
    ).rejects.toThrow();
  });

  it.each<[string, (signature: Signature) => Uint8Array]>([
    ["written to another schema", (signature) => objectFormat.encode(new ObjectValue(note.link, dataOf(signature)))],
    ["written to itself", (signature) => objectFormat.encode(new ObjectValue(itself, dataOf(signature)))],
  ])("is refused as an object %s", async (_, change) => {
    const signature = await sign(hello, signer(ed25519));
    await expect(verified(change(signature), identityOf(signature))).rejects.toThrow();
  });

  it("is refused with a byte after it", async () => {
    const signature = await sign(hello, signer(ed25519));
    await expect(verified(Uint8Array.of(...bytesOf(signature), 0), identityOf(signature))).rejects.toThrow();
  });

  it("reads as an object written to the signature schema, which does not verify it", async () => {
    for (const scheme of schemes) {
      const signature = await sign(hello, signer(scheme));
      expect(decodeObject(bytesOf(signature), signatureSchema).link).toBe(signature.link);
    }
    const signature = await sign(hello, signer(ed25519));
    const unverified = rewritten(signature, { object: new LinkValue(goodbye.link) });
    expect(decodeObject(unverified, signatureSchema).data).toMatchObject({ object: new LinkValue(goodbye.link) });
    await expect(verified(unverified, identityOf(signature))).rejects.toThrow(/does not verify/);
  });
});

describe("signatures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("give a signature they have read again, without asking the reader or verifying it again", async () => {
    const signature = await sign(hello, signer(ed25519));
    const { signatures } = freshKit();
    const read = await signatures.read(signature.link, blobsByLink(signature.blobs));
    const verify = vi.spyOn(ed25519, "verify");
    expect(await signatures.read(signature.link, new Map())).toEqual(read);
    expect(verify).not.toHaveBeenCalled();
  });

  it("give a signature their actor signed without asking the reader", async () => {
    const by = signer(ed25519);
    const { signatures, publish } = freshKit();
    const signature = await signatures.actor(by, await publish(by), identityVersionInHand).sign(hello);
    expect(await signatures.read(signature.link, new Map())).toEqual(signature);
  });

  it("read a signature by a signed identity they have read, verifying the signature alone", async () => {
    const signature = await sign(hello, signer(ed25519));
    const { signatures, signedIdentities } = freshKit();
    await signedIdentities.read(signature.signedIdentity.link, identityOf(signature));
    const verify = vi.spyOn(ed25519, "verify");
    expect(await signatures.read(signature.link, blobsByLink([bytesOf(signature)]))).toEqual(signature);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("read a signature they were refused for a blob the reader did not give, once a reader gives it", async () => {
    const signature = await sign(hello, signer(ed25519));
    const { signatures } = freshKit();
    await expect(signatures.read(signature.link, blobsByLink([bytesOf(signature)]))).rejects.toThrow(AbsentBlob);
    expect(await signatures.read(signature.link, blobsByLink(signature.blobs))).toEqual(signature);
  });
});

describe("a signature by an agent", () => {
  it("by the second agent reads back with that agent as its key, named by its index after the root's", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const signature = await signatures.actor(signer(ed25519, 3), signedIdentity, identityVersionInHand).sign(hello);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(read.signedIdentity).toEqual(signedIdentity);
    expect(read.key).toEqual(signedIdentity.identity.agents[1]);
    expect(read.signature[0]).toBe(2);
    expect(read.signature).toHaveLength(65);
  });

  it("in another scheme than its root is read in the agent's scheme", async () => {
    const signedIdentity = await publish(signer(eip191), { agents: [key(ed25519, 2)] });
    const signature = await signatures.actor(signer(ed25519, 2), signedIdentity, identityVersionInHand).sign(hello);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(isSameKey(read.key, key(ed25519, 2))).toBe(true);
  });

  it.each<[string, (signature: Uint8Array) => Uint8Array]>([
    ["another agent's index", (signature) => Uint8Array.of(1, ...signature.subarray(1))],
    ["the root's index", (signature) => Uint8Array.of(0, ...signature.subarray(1))],
    ["an index past its agents", (signature) => Uint8Array.of(3, ...signature.subarray(1))],
    ["no index", (signature) => signature.subarray(1)],
    ["no bytes", () => new Uint8Array()],
  ])("is refused with %s", async (_, change) => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const signature = await signatures.actor(signer(ed25519, 3), signedIdentity, identityVersionInHand).sign(hello);
    const bytes = rewritten(signature, { signature: change(signature.signature) });
    await expect(verified(bytes, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("made for one identity does not verify for another that lists the same agent", async () => {
    const agent = signer(ed25519, 3);
    const signedIdentity = await publish(signer(ed25519), { agents: [agent.key] });
    const signature = await signatures.actor(agent, signedIdentity, identityVersionInHand).sign(hello);
    const other = await publish(signer(ed25519, 2), { agents: [agent.key] });
    await expect(
      verified(rewritten(signature, { signedIdentity: new LinkValue(other.link) }), byLink(other)),
    ).rejects.toThrow(/does not verify/);
  });
});

describe("a signature by a root", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is named by index 0, before the agents", async () => {
    const signedIdentity = await publish(wallet, { agents: [laptop.key] });
    const signature = await signatures.actor(wallet, signedIdentity, identityVersionInHand).sign(hello);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(read.key).toEqual(signedIdentity.identity.root);
    expect(read.signature[0]).toBe(0);
  });
});

describe("what a signature signs", () => {
  it("is the signed identity it names, not only its root and the index of its agent", async () => {
    const [root, agent] = [signer(ed25519), signer(ed25519, 3)];
    const signedIdentity = await publish(root, { agents: [agent.key, key(ed25519, 2)] });
    const other = await publish(root, { agents: [agent.key] });
    const signature = await signatures.actor(agent, signedIdentity, identityVersionInHand).sign(hello);
    expect((await verified(bytesOf(signature), identityOf(signature))).link).toBe(signature.link);
    await expect(
      verified(rewritten(signature, { signedIdentity: new LinkValue(other.link) }), byLink(other)),
    ).rejects.toThrow(/does not verify/);
  });

  it("is not the object alone, as a root signs an identity", async () => {
    const by = signer(ed25519);
    const signature = await sign(hello, by);
    const bare = await by.sign(digestOf(hello.link));
    await expect(verified(rewritten(signature, { signature: bare }), identityOf(signature))).rejects.toThrow(
      /does not verify/,
    );
  });

  it("is not met by the root's signature over its identity", async () => {
    const signedIdentity = await publish(signer(ed25519));
    const signature = await signatures.actor(signer(ed25519), signedIdentity, identityVersionInHand).sign(hello);
    const recast = rewritten(signature, {
      object: new LinkValue(signedIdentity.identity.link),
      signature: signedIdentity.signature,
    });
    await expect(verified(recast, byLink(signedIdentity))).rejects.toThrow(/does not verify/);
  });
});

describe("the implementation of the signature schema", () => {
  const read = async (bytes: Uint8Array, blobs: Reader = new Map()) =>
    freshKit().signatures.implementation.read(decodeObject(bytes, signatureSchema), blobs);

  it("reads a signature as verifying it does", async () => {
    const signature = await sign(hello, signer(ed25519));
    const blobs = identityOf(signature);
    expect(await read(bytesOf(signature), blobs)).toEqual(await verified(bytesOf(signature), blobs));
  });

  it("reads a signature by an identity version before a crisis, though the reader gives the crisis", async () => {
    const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const signature = await signatures.actor(laptop, first, identityVersionInHand).sign(hello);
    expect((await read(bytesOf(signature), byLink(first, crisis))).link).toBe(signature.link);
  });

  it("refuses a signature that does not verify", async () => {
    const signature = await sign(hello, signer(ed25519));
    const unverified = rewritten(signature, { object: new LinkValue(goodbye.link) });
    await expect(read(unverified, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("refuses a signature without the blob of its signed identity, by an error that has its link", async () => {
    const signature = await sign(hello, signer(ed25519));
    const error = await read(bytesOf(signature)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AbsentBlob);
    expect(error).toHaveProperty("link", signature.signedIdentity.link);
  });
});

describe("an identity actor", () => {
  const root = signer(ed25519);
  const agent = signer(ed25519, 2);

  it("signs for the root and the agents of its identity, and for no other signer", async () => {
    const signedIdentity = await publish(root, { agents: [agent.key] });
    const signatureBy = (by: Signer) => signatures.actor(by, signedIdentity, identityVersionInHand).sign(hello);
    expect((await signatureBy(root)).key).toBe(signedIdentity.identity.root);
    expect((await signatureBy(agent)).key).toBe(signedIdentity.identity.agents[0]);
    await expect(signatureBy(signer(ed25519, 3))).rejects.toThrow(/does not sign for/);
    await expect(signatureBy(signer(solanaOffchain))).rejects.toThrow(/does not sign for/);
  });

  it("refuses a signature that does not verify for its key", async () => {
    const signedIdentity = await publish(agent);
    const wrong: Signer = { key: agent.key, sign: (digest, by) => root.sign(digest, by) };
    await expect(signatures.actor(wrong, signedIdentity, identityVersionInHand).sign(hello)).rejects.toThrow(
      /does not verify/,
    );
  });

  it("is identified by the identifier of the signed identity it is made with", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const actor = signatures.actor(root, signedIdentity, identityVersionInHand);
    expect(actor.identifier).toBe(signedIdentity.identity.identifier);
  });

  it("asks which identity version is current with the signed identity it is made with in hand", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const later = await publish(root, { prior: signedIdentity, at: 2_000 });
    const actor = signatures.actor(root, signedIdentity, async (inHand) =>
      inHand === signedIdentity ? later : inHand,
    );
    expect((await actor.sign(hello)).signedIdentity.link).toBe(later.link);
  });

  it("signs by the identity version that is current when it signs", async () => {
    const first = await publish(root, { agents: [agent.key], at: 1_000 });
    const second = await publish(root, { prior: first, agents: [agent.key, key(ed25519, 3)], at: 2_000 });
    let current = first;
    const actor = signatures.actor(agent, first, async () => current);
    expect((await actor.sign(hello)).signedIdentity.link).toBe(first.link);
    current = second;
    expect((await actor.sign(hello)).signedIdentity.link).toBe(second.link);
  });

  it("signs nothing once the current identity version does not list its key", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const removal = await publish(root, { prior: listing, at: 2_000 });
    const actor = signatures.actor(agent, listing, async () => removal);
    await expect(actor.sign(hello)).rejects.toThrow(/does not sign for/);
  });

  it("signs nothing by an identity version of another identifier, though it lists its key", async () => {
    const signedIdentity = await publish(root, { agents: [agent.key], at: 1_000 });
    const other = await publish(signer(ed25519, 3), { agents: [agent.key], at: 1_000 });
    const sign = vi.fn((digest: Uint8Array, by?: Uint8Array) => agent.sign(digest, by));
    const actor = signatures.actor({ key: agent.key, sign }, signedIdentity, async () => other);
    await expect(actor.sign(hello)).rejects.toThrow(/the actor signs for/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("signs once a later identity version lists its key, when the one it is made with does not", async () => {
    const first = await publish(root, { at: 1_000 });
    const listing = await publish(root, { prior: first, agents: [agent.key], at: 2_000 });
    const actor = signatures.actor(agent, first, async () => listing);
    expect(isSameKey((await actor.sign(hello)).key, agent.key)).toBe(true);
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await sign(hello, signer(ed25519));
  expect(() => decodeObject(bytesOf(signature), note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(hello.bytes, signatures.schema)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(note.bytes, signatures.schema)).toThrow();
});
