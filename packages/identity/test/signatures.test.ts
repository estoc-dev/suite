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
  type ValueMap,
} from "@estoc/object";
import { rootSchema, schema, string } from "@estoc/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import {
  type Arrivals,
  type CurveScheme,
  ed25519,
  eip191,
  isSameKey,
  loadIdentity,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  signatureSchema,
  solanaOffchain,
} from "../src/index.ts";
import { byLink as blobsByLink, bytesOf, dataOf, rowsOf, schemaLinkOf, schemes } from "./fixtures.ts";

const { identities, signatures, identityVersions, publish } = loadIdentity(schemes);
const verifiedBy = async (by: Signatures, bytes: Uint8Array, blobs: Reader = new Map()) =>
  by.verify(decodeObject(bytes, by.schema), blobs);
const verified = (bytes: Uint8Array, blobs?: Reader) => verifiedBy(signatures, bytes, blobs);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const written = (signature: Signature, data: ValueMap) =>
  objectFormat.encode(new ObjectValue(schemaLinkOf(signature), data));
const rewritten = (signature: Signature, change: ValueMap) => written(signature, { ...dataOf(signature), ...change });
const linksOf = (blobs: readonly Uint8Array[]) => blobs.map((bytes) => linkOf(bytes));
const byLink = (...identities: SignedIdentityObject[]) => blobsByLink(identities.flatMap(({ blobs }) => blobs));
const identityOf = (signature: Signature) => byLink(signature.signedIdentity);
const peopleHavingSeen = (...versions: SignedIdentityObject[]) =>
  identityVersions.people(rowsOf(identityVersions, ...versions), byLink(...versions));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.sign(by, await publish(by, { at: 0 }), object);

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
    expect(await signatures.read(signature.link, blobsByLink(signature.blobs))).toEqual(signature);
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

describe("a signature by an agent", () => {
  it("by the second agent reads back with that agent as its key, named by its index after the root's", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2), key(ed25519, 3)] });
    const signature = await signatures.sign(signer(ed25519, 3), signedIdentity, hello);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(read.signedIdentity).toEqual(signedIdentity);
    expect(read.key).toEqual(signedIdentity.identity.agents[1]);
    expect(read.signature[0]).toBe(2);
    expect(read.signature).toHaveLength(65);
  });

  it("in another scheme than its root is read in the agent's scheme", async () => {
    const signedIdentity = await publish(signer(eip191), { agents: [key(ed25519, 2)] });
    const signature = await signatures.sign(signer(ed25519, 2), signedIdentity, hello);
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
    const signature = await signatures.sign(signer(ed25519, 3), signedIdentity, hello);
    const bytes = rewritten(signature, { signature: change(signature.signature) });
    await expect(verified(bytes, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("made for one identity does not verify for another that lists the same agent", async () => {
    const agent = signer(ed25519, 3);
    const signedIdentity = await publish(signer(ed25519), { agents: [agent.key] });
    const signature = await signatures.sign(agent, signedIdentity, hello);
    const other = await publish(signer(ed25519, 2), { agents: [agent.key] });
    await expect(
      verified(rewritten(signature, { signedIdentity: new LinkValue(other.link) }), byLink(other)),
    ).rejects.toThrow(/does not verify/);
  });
});

describe("a signature by an agent, as identity versions follow one another", () => {
  const [wallet, laptop, phone] = [signer(eip191), signer(ed25519, 2), signer(ed25519, 3)];

  it("is honored when the latest identity version the reader has seen lists its agent, whichever identity version it carries", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key, laptop.key], at: 2_000 });
    const signature = await signatures.sign(laptop, first, hello);
    expect(await peopleHavingSeen(second).honors(signature)).toBe(true);
  });

  it("is not honored when the latest identity version the reader has seen no longer lists its agent", async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.sign(laptop, first, hello);
    expect(await peopleHavingSeen(second).honors(signature)).toBe(false);
  });

  it("is not honored when the latest identity version the reader has seen lists no agents", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, at: 2_000 });
    const signature = await signatures.sign(laptop, earlier, hello);
    expect(await peopleHavingSeen(later).honors(signature)).toBe(false);
  });

  it("is honored by the identity version it carries when that is later than any the reader has seen", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 2_000 });
    const signature = await signatures.sign(phone, second, hello);
    expect(await peopleHavingSeen(first).honors(signature)).toBe(true);
  });

  it("is honored, against an identity version at the same at that drops its agent, when the one that lists it has the greater link", async () => {
    const first = await publish(wallet, { at: 500 });
    const listing = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 1_000 });
    const dropping = await publish(wallet, { prior: first, agents: [phone.key], at: 1_000 });
    const signature = await signatures.sign(laptop, listing, hello);
    expect(await peopleHavingSeen(dropping).honors(signature)).toBe(listing.link > dropping.link);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.sign(laptop, first, hello);
    expect(await peopleHavingSeen().honors(signature)).toBe(true);
  });
});

describe("a signature as of when it came to the reader's devices", () => {
  const [wallet, laptop, phone] = [signer(eip191), signer(ed25519, 2), signer(ed25519, 3)];
  const chain = async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    return { first, second, signature: await signatures.sign(laptop, first, hello) };
  };
  const arrivalsOf = (...arrivals: readonly (readonly [{ readonly link: Link<unknown> }, number])[]): Arrivals => {
    const times = new Map(arrivals.map(([{ link }, at]) => [link, at]));
    return { atOf: (link) => times.get(link) };
  };

  it("is honored when it came before an identity version that takes its key out", async () => {
    const { first, second, signature } = await chain();
    const people = peopleHavingSeen(second);
    const arrivals = arrivalsOf([first, 1], [signature, 5], [second, 9]);
    expect(await people.asOfArrival(arrivals).honors(signature)).toBe(true);
    expect(await people.honors(signature)).toBe(false);
  });

  it("is not honored when it came after, though the identity version it carries lists its key", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [second, 5], [signature, 9]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is not honored when it came at the same time as that identity version", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [second, 5], [signature, 5]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is not honored when nothing says when that identity version came", async () => {
    const { first, second, signature } = await chain();
    const arrivals = arrivalsOf([first, 1], [signature, 5]);
    expect(await peopleHavingSeen(second).asOfArrival(arrivals).honors(signature)).toBe(false);
  });

  it("is cut by a crisis that came after it", async () => {
    const { first, signature } = await chain();
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const byCrisis = await signatures.sign(laptop, crisis, hello);
    const peopleAsOfArrival = peopleHavingSeen(crisis).asOfArrival(
      arrivalsOf([first, 1], [signature, 5], [crisis, 9], [byCrisis, 9]),
    );
    expect(await peopleAsOfArrival.honors(signature)).toBe(false);
    expect(await peopleAsOfArrival.honors(byCrisis)).toBe(true);
  });

  it("is honored as one that comes in now when nothing says when it came", async () => {
    const { first, second, signature } = await chain();
    const peopleAsOfArrival = peopleHavingSeen(second).asOfArrival(arrivalsOf([first, 1], [second, 9]));
    expect(await peopleAsOfArrival.honors(signature)).toBe(false);
    expect(await peopleAsOfArrival.honors(await signatures.sign(phone, first, hello))).toBe(true);
  });
});

describe("a signature by a root", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is named by index 0, before the agents", async () => {
    const signedIdentity = await publish(wallet, { agents: [laptop.key] });
    const signature = await signatures.sign(wallet, signedIdentity, hello);
    const read = await verified(bytesOf(signature), identityOf(signature));
    expect(read.key).toEqual(signedIdentity.identity.root);
    expect(read.signature[0]).toBe(0);
  });

  it("is honored whichever agents the latest identity version the reader has seen lists", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const later = await publish(wallet, { prior: published, agents: [laptop.key], at: 2_000 });
    const signature = await signatures.sign(wallet, published, hello);
    expect(await peopleHavingSeen(later).honors(signature)).toBe(true);
  });
});

describe("a signature by an identity version before a crisis", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
  const chain = async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, agents: [laptop.key], at: 3_000 });
    return { first, crisis, after };
  };

  it.each([
    ["an agent the crisis lists again", laptop],
    ["the root", wallet],
  ])("by %s is not honored once the reader has seen the crisis", async (_, by) => {
    const { first, crisis } = await chain();
    const signature = await signatures.sign(by, first, hello);
    expect(await peopleHavingSeen(crisis).honors(signature)).toBe(false);
  });

  it("is not honored by a reader that has seen only an identity version that follows the crisis", async () => {
    const { first, after } = await chain();
    const people = identityVersions.people(rowsOf(identityVersions, after), byLink(after));
    expect(await people.honors(await signatures.sign(wallet, first, hello))).toBe(false);
    expect(await people.honors(await signatures.sign(laptop, first, hello))).toBe(false);
  });

  it("is not honored once the signature of an identity version that follows the crisis carries it to the reader", async () => {
    const { first, after } = await chain();
    const reading = peopleHavingSeen(first);
    expect(await reading.honors(await signatures.sign(laptop, after, hello))).toBe(true);
    expect(await reading.honors(await signatures.sign(laptop, first, hello))).toBe(true);
    const seeing = peopleHavingSeen(first, after);
    expect(await seeing.honors(await signatures.sign(laptop, first, hello))).toBe(false);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const { first } = await chain();
    const signature = await signatures.sign(laptop, first, hello);
    expect(await peopleHavingSeen().honors(signature)).toBe(true);
  });

  it("is not honored once the reader has seen a later crisis that follows it", async () => {
    const { crisis } = await chain();
    const later = await publish(wallet, { prior: crisis, agents: [laptop.key], isCrisis: true, at: 4_000 });
    const people = peopleHavingSeen(later);
    expect(await people.honors(await signatures.sign(laptop, crisis, hello))).toBe(false);
    expect(await people.honors(await signatures.sign(laptop, later, hello))).toBe(true);
  });
});

describe("a signature by the crisis or an identity version that follows it", () => {
  it("is honored, by the root and by an agent", async () => {
    const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(after);
    expect(await people.honors(await signatures.sign(wallet, crisis, hello))).toBe(true);
    expect(await people.honors(await signatures.sign(laptop, after, hello))).toBe(true);
  });
});

describe("a signature on a branch that does not follow the crisis", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is not honored once the reader has seen the crisis, though the branch is later", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.sign(laptop, branch, hello))).toBe(false);
    expect(await people.honors(await signatures.sign(wallet, branch, hello))).toBe(false);
    expect(await peopleHavingSeen(branch).honors(await signatures.sign(laptop, branch, hello))).toBe(true);
  });

  it("with a crisis of its own is honored over an earlier crisis on another branch", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.sign(laptop, branch, hello))).toBe(true);
    expect(await people.honors(await signatures.sign(wallet, crisis, hello))).toBe(false);
  });
});

describe("what a signature signs", () => {
  it("is the signed identity it names, not only its root and the index of its agent", async () => {
    const [root, agent] = [signer(ed25519), signer(ed25519, 3)];
    const signedIdentity = await publish(root, { agents: [agent.key, key(ed25519, 2)] });
    const other = await publish(root, { agents: [agent.key] });
    const signature = await signatures.sign(agent, signedIdentity, hello);
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
    const signature = await signatures.sign(signer(ed25519), signedIdentity, hello);
    const recast = rewritten(signature, {
      object: new LinkValue(signedIdentity.identity.link),
      signature: signedIdentity.signature,
    });
    await expect(verified(recast, byLink(signedIdentity))).rejects.toThrow(/does not verify/);
  });
});

describe("the implementation of the signature schema", () => {
  const { implementation } = signatures;
  const read = async (bytes: Uint8Array, blobs: Reader = new Map()) =>
    implementation.read(decodeObject(bytes, implementation.schema), blobs);

  it("reads a signature as verifying it does", async () => {
    const signature = await sign(hello, signer(ed25519));
    const blobs = identityOf(signature);
    expect(await read(bytesOf(signature), blobs)).toEqual(await verified(bytesOf(signature), blobs));
  });

  it("reads a signature by an identity version before a crisis, though the reader gives the crisis", async () => {
    const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const signature = await signatures.sign(laptop, first, hello);
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

describe("the selection of the signatures over objects of a schema", () => {
  const notes = signatures.selectionOver(note);
  const readerOf = (...blobs: readonly Uint8Array[]) => blobsByLink(blobs);

  it("reads a signature over an object of the schema as the implementation does, with the object", async () => {
    const signature = await sign(hello, signer(ed25519));
    const reader = readerOf(...signature.blobs, hello.bytes);
    const read = await notes.read(signature.link, reader);
    const object = decodeObject(bytesOf(signature), signatureSchema);
    expect(read?.signature).toEqual(await signatures.implementation.read(object, reader));
    expect(read?.object.link).toBe(hello.link);
    expect(read?.object.data).toEqual({ text: "hello" });
  });

  it("leaves out a signature over an object of another schema without verifying it, and what is not a signature", async () => {
    const card = encodeObject(schema("Card", { name: string() }), { name: "Alice" });
    const signature = await sign(card, signer(ed25519));
    expect(await notes.read(signature.link, readerOf(bytesOf(signature), card.bytes))).toBeUndefined();
    expect(await notes.read(hello.link, readerOf(hello.bytes))).toBeUndefined();
  });

  it("refuses a signature that does not verify", async () => {
    const signature = await sign(hello, signer(ed25519));
    const bytes = rewritten(signature, { object: new LinkValue(goodbye.link) });
    const reader = readerOf(bytes, goodbye.bytes, ...signature.signedIdentity.blobs);
    await expect(notes.read(linkOf(bytes), reader)).rejects.toThrow(/does not verify/);
  });

  it("refuses a signature without the blob of its signed identity, by an error that has its link", async () => {
    const signature = await sign(hello, signer(ed25519));
    const reader = readerOf(bytesOf(signature), hello.bytes);
    const error = await notes.read(signature.link, reader).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AbsentBlob);
    expect(error).toHaveProperty("link", signature.signedIdentity.link);
  });

  it("refuses a signature whose object the reader does not give, or which does not fit the schema", async () => {
    const signature = await sign(hello, signer(ed25519));
    await expect(notes.read(signature.link, readerOf(bytesOf(signature)))).rejects.toThrow(/no blob is given/);
    const bytes = objectFormat.encode(new ObjectValue(note.link, { title: "hello" }));
    const unfit = await sign({ link: linkOf(bytes) }, signer(ed25519));
    await expect(notes.read(unfit.link, readerOf(bytesOf(unfit), bytes))).rejects.toThrow(/does not fit its schema/);
  });
});

describe("a signature made for a signed identity", () => {
  it("carries that signed identity", async () => {
    const signedIdentity = await publish(signer(ed25519));
    const signature = await signatures.sign(signer(ed25519), signedIdentity, hello);
    expect(signature.signedIdentity).toBe(signedIdentity);
    expect(dataOf(signature).signedIdentity).toEqual(new LinkValue(signedIdentity.link));
  });

  it("is made by the root and the agents of its identity, and by no other signer", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2)] });
    expect((await signatures.sign(signer(ed25519), signedIdentity, hello)).key).toBe(signedIdentity.identity.root);
    expect((await signatures.sign(signer(ed25519, 2), signedIdentity, hello)).key).toBe(
      signedIdentity.identity.agents[0],
    );
    await expect(signatures.sign(signer(ed25519, 3), signedIdentity, hello)).rejects.toThrow(/does not sign for/);
    await expect(signatures.sign(signer(solanaOffchain), signedIdentity, hello)).rejects.toThrow(/does not sign for/);
  });

  it("is refused when it does not verify for its key", async () => {
    const signedIdentity = await publish(signer(ed25519, 2));
    const wrong: Signer = {
      key: signer(ed25519, 2).key,
      sign: (digest, by) => signer(ed25519).sign(digest, by),
    };
    await expect(signatures.sign(wrong, signedIdentity, hello)).rejects.toThrow(/does not verify/);
  });
});

describe("an identity actor", () => {
  const root = signer(ed25519);
  const agent = signer(ed25519, 2);

  it("is identified by the identifier of the signed identity it is made with", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const actor = signatures.actor(root, signedIdentity, async () => peopleHavingSeen());
    expect(actor.identifier).toBe(signedIdentity.identity.identifier);
  });

  it("signs by the signed identity it is made with while the people it asks have seen none later", async () => {
    const signedIdentity = await publish(root, { at: 1_000 });
    const actor = signatures.actor(root, signedIdentity, async () => peopleHavingSeen());
    expect((await actor.sign(hello)).signedIdentity.link).toBe(signedIdentity.link);
  });

  it("signs by the identity version that is current when it signs", async () => {
    const first = await publish(root, { agents: [agent.key], at: 1_000 });
    const second = await publish(root, { prior: first, agents: [agent.key, key(ed25519, 3)], at: 2_000 });
    let people = peopleHavingSeen();
    const actor = signatures.actor(agent, first, async () => people);
    expect((await actor.sign(hello)).signedIdentity.link).toBe(first.link);
    people = peopleHavingSeen(second);
    const signature = await actor.sign(hello);
    expect(signature.signedIdentity.link).toBe(second.link);
    expect(await people.honors(signature)).toBe(true);
  });

  it("signs nothing once the current identity version does not list its key", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const removal = await publish(root, { prior: listing, at: 2_000 });
    const actor = signatures.actor(agent, listing, async () => peopleHavingSeen(removal));
    await expect(actor.sign(hello)).rejects.toThrow(/does not sign for/);
  });

  it("signs once a later identity version lists its key, when the one it is made with does not", async () => {
    const first = await publish(root, { at: 1_000 });
    const listing = await publish(root, { prior: first, agents: [agent.key], at: 2_000 });
    const actor = signatures.actor(agent, first, async () => peopleHavingSeen(listing));
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
