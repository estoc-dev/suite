import {
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
import { schema, string } from "@estoc/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  isSameKey,
  loadIdentity,
  noIdentityVersions,
  type SeenIdentityVersions,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  signatureSchema,
  solanaOffchain,
} from "../src/index.ts";
import { rowsOf, schemes, storeOf } from "./fixtures.ts";

const { identities, signatures, identityVersions, publish } = loadIdentity(schemes);
const verifiedBy = async (
  by: Signatures,
  bytes: Uint8Array,
  blobs: Reader = new Map(),
  seenIdentityVersions = noIdentityVersions,
) => by.verify(decodeObject(bytes, by.schema), blobs, seenIdentityVersions);
const verified = (bytes: Uint8Array, blobs?: Reader, seenIdentityVersions?: SeenIdentityVersions) =>
  verifiedBy(signatures, bytes, blobs, seenIdentityVersions);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const fieldsOf = (object: { readonly bytes: Uint8Array }) => objectFormat.decode(object.bytes);
const dataOf = (object: { readonly bytes: Uint8Array }) => fieldsOf(object).data;
const written = (signature: Signature, data: ValueMap) =>
  objectFormat.encode(new ObjectValue(fieldsOf(signature).schema, data));
const rewritten = (signature: Signature, change: ValueMap) => written(signature, { ...dataOf(signature), ...change });
const byLink = (...identities: SignedIdentityObject[]) =>
  new Map(identities.flatMap(({ blobs }) => blobs).map((bytes) => [linkOf(bytes), bytes]));
const identityOf = (signature: Signature) => byLink(signature.signedIdentity);
const peopleHavingSeen = (...signed: SignedIdentityObject[]) =>
  identityVersions.people(rowsOf(identityVersions, ...signed), storeOf(signed.flatMap(({ blobs }) => blobs)));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, { at: 0 })).sign(object);

const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello" });
const goodbye = encodeObject(note, { text: "goodbye" });

describe("a signature", () => {
  it.each(schemes)("by a $name key reads back with its identity and object", async (scheme) => {
    const by = signer(scheme);
    const signature = await sign(hello, by);
    const read = await verified(signature.bytes, identityOf(signature));
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

  it("is refused without the blobs of its identity", async () => {
    const signature = await sign(hello, signer(ed25519));
    await expect(verified(signature.bytes)).rejects.toThrow(/no blob is given/);
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
    await expect(verified(Uint8Array.of(...signature.bytes, 0), identityOf(signature))).rejects.toThrow();
  });

  it("reads as an object written to the signature schema, which does not verify it", async () => {
    for (const scheme of schemes) {
      const signature = await sign(hello, signer(scheme));
      // Without its label, as bytes read from a file or the network have none.
      const bytes: Uint8Array = signature.bytes;
      expect(decodeObject(bytes, signatureSchema).link).toBe(signature.link);
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
    const signature = await signatures.actor(signer(ed25519, 3), signedIdentity).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(read.signedIdentity).toEqual(signedIdentity);
    expect(read.key).toEqual(signedIdentity.identity.agents[1]);
    expect(read.signature[0]).toBe(2);
    expect(read.signature).toHaveLength(65);
  });

  it("in another scheme than its root is read in the agent's scheme", async () => {
    const signedIdentity = await publish(signer(eip191), { agents: [key(ed25519, 2)] });
    const signature = await signatures.actor(signer(ed25519, 2), signedIdentity).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature));
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
    const signature = await signatures.actor(signer(ed25519, 3), signedIdentity).sign(hello);
    const bytes = rewritten(signature, { signature: change(signature.signature) });
    await expect(verified(bytes, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("made for one identity does not verify for another that lists the same agent", async () => {
    const agent = signer(ed25519, 3);
    const signedIdentity = await publish(signer(ed25519), { agents: [agent.key] });
    const signature = await signatures.actor(agent, signedIdentity).sign(hello);
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
    const signature = await signatures.actor(laptop, first).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature), peopleHavingSeen(second));
    expect(read.signedIdentity).toEqual(first);
  });

  it("is refused when the latest identity version the reader has seen no longer lists its agent", async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.actor(laptop, first).sign(hello);
    await expect(verified(signature.bytes, identityOf(signature), peopleHavingSeen(second))).rejects.toThrow(
      /is not honored/,
    );
  });

  it("is refused when the latest identity version the reader has seen lists no agents", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, at: 2_000 });
    const signature = await signatures.actor(laptop, earlier).sign(hello);
    await expect(verified(signature.bytes, identityOf(signature), peopleHavingSeen(later))).rejects.toThrow(
      /is not honored/,
    );
  });

  it("is verified against the identity version it carries when that is later than any the reader has seen", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 2_000 });
    const signature = await signatures.actor(phone, second).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature), peopleHavingSeen(first));
    expect(isSameKey(read.key, phone.key)).toBe(true);
  });

  it("is verified, against an identity version at the same at that drops its agent, by whichever has the greater link", async () => {
    const first = await publish(wallet, { at: 500 });
    const listing = await publish(wallet, { prior: first, agents: [laptop.key, phone.key], at: 1_000 });
    const dropping = await publish(wallet, { prior: first, agents: [phone.key], at: 1_000 });
    const signature = await signatures.actor(laptop, listing).sign(hello);
    const isHonored = await verified(signature.bytes, identityOf(signature), peopleHavingSeen(dropping)).then(
      () => true,
      () => false,
    );
    expect(isHonored).toBe(listing.link > dropping.link);
  });

  it("is honored by the people of what the reader has seen as it is verified by them", async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const people = peopleHavingSeen(second);
    expect(await people.honors(await signatures.actor(laptop, first).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(phone, first).sign(hello))).toBe(true);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    const signature = await signatures.actor(laptop, first).sign(hello);
    expect((await verified(signature.bytes, identityOf(signature), noIdentityVersions)).link).toBe(signature.link);
  });
});

describe("a signature as the store took it in", () => {
  const [wallet, laptop, phone] = [signer(eip191), signer(ed25519, 2), signer(ed25519, 3)];
  const chain = async () => {
    const first = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    return { first, second, signature: await signatures.actor(laptop, first).sign(hello) };
  };

  it("is honored when the store took it in before an identity version that takes its key out", async () => {
    const { first, second, signature } = await chain();
    const people = identityVersions.people(
      rowsOf(identityVersions, second),
      storeOf([...first.blobs, signature.bytes, ...second.blobs]),
    );
    expect(await people.asTakenIn.honors(signature)).toBe(true);
    expect(await people.honors(signature)).toBe(false);
  });

  it("is not honored when the store took it in after, though the identity version it carries lists its key", async () => {
    const { first, second, signature } = await chain();
    const people = identityVersions.people(
      rowsOf(identityVersions, second),
      storeOf([...first.blobs, ...second.blobs, signature.bytes]),
    );
    expect(await people.asTakenIn.honors(signature)).toBe(false);
  });

  it("is cut by a crisis that the store took in after it", async () => {
    const { first, signature } = await chain();
    const crisis = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 2_000 });
    const byCrisis = await signatures.actor(laptop, crisis).sign(hello);
    const people = identityVersions.people(
      rowsOf(identityVersions, crisis),
      storeOf([...first.blobs, signature.bytes, ...crisis.blobs, byCrisis.bytes]),
    );
    expect(await people.asTakenIn.honors(signature)).toBe(false);
    expect(await people.asTakenIn.honors(byCrisis)).toBe(true);
  });

  it("is honored as one that comes in now when the store does not hold it", async () => {
    const { first, second, signature } = await chain();
    const people = identityVersions.people(
      rowsOf(identityVersions, second),
      storeOf([...first.blobs, ...second.blobs]),
    );
    expect(await people.asTakenIn.honors(signature)).toBe(false);
    expect(await people.asTakenIn.honors(await signatures.actor(phone, first).sign(hello))).toBe(true);
  });
});

describe("a signature by a root", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is named by index 0, before the agents", async () => {
    const signedIdentity = await publish(wallet, { agents: [laptop.key] });
    const signature = await signatures.actor(wallet, signedIdentity).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(read.key).toEqual(signedIdentity.identity.root);
    expect(read.signature[0]).toBe(0);
  });

  it("is honored whichever agents the latest identity version the reader has seen lists", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const later = await publish(wallet, { prior: published, agents: [laptop.key], at: 2_000 });
    const signature = await signatures.actor(wallet, published).sign(hello);
    expect((await verified(signature.bytes, identityOf(signature), peopleHavingSeen(later))).link).toBe(signature.link);
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
  ])("by %s is refused once the reader has seen the crisis", async (_, by) => {
    const { first, crisis } = await chain();
    const signature = await signatures.actor(by, first).sign(hello);
    await expect(verified(signature.bytes, identityOf(signature), peopleHavingSeen(crisis))).rejects.toThrow(
      /is not honored/,
    );
  });

  it("is refused by a reader that has seen only an identity version that follows the crisis", async () => {
    const { first, after } = await chain();
    const people = identityVersions.people(rowsOf(identityVersions, after), storeOf(after.blobs));
    expect(await people.honors(await signatures.actor(wallet, first).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(laptop, first).sign(hello))).toBe(false);
  });

  it("is refused once the signature of an identity version that follows the crisis carries it to the reader", async () => {
    const { first, after } = await chain();
    const reading = peopleHavingSeen(first);
    expect(await reading.honors(await signatures.actor(laptop, after).sign(hello))).toBe(true);
    expect(await reading.honors(await signatures.actor(laptop, first).sign(hello))).toBe(true);
    const seeing = peopleHavingSeen(first, after);
    expect(await seeing.honors(await signatures.actor(laptop, first).sign(hello))).toBe(false);
  });

  it("is honored by the identity version it carries when the reader has seen no identity versions", async () => {
    const { first } = await chain();
    const signature = await signatures.actor(laptop, first).sign(hello);
    expect((await verified(signature.bytes, identityOf(signature), noIdentityVersions)).link).toBe(signature.link);
  });

  it("is refused once the reader has seen a later crisis that follows it", async () => {
    const { crisis } = await chain();
    const later = await publish(wallet, { prior: crisis, agents: [laptop.key], isCrisis: true, at: 4_000 });
    const people = peopleHavingSeen(later);
    expect(await people.honors(await signatures.actor(laptop, crisis).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(laptop, later).sign(hello))).toBe(true);
  });
});

describe("a signature by the crisis or an identity version that follows it", () => {
  it("is honored, by the root and by an agent", async () => {
    const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];
    const first = await publish(wallet, { agents: [laptop.key], at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const after = await publish(wallet, { prior: crisis, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(after);
    expect(await people.honors(await signatures.actor(wallet, crisis).sign(hello))).toBe(true);
    expect(await people.honors(await signatures.actor(laptop, after).sign(hello))).toBe(true);
  });
});

describe("a signature on a branch that does not follow the crisis", () => {
  const [wallet, laptop] = [signer(eip191), signer(ed25519, 2)];

  it("is refused once the reader has seen the crisis, though the branch is later", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.actor(laptop, branch).sign(hello))).toBe(false);
    expect(await people.honors(await signatures.actor(wallet, branch).sign(hello))).toBe(false);
    expect(await peopleHavingSeen(branch).honors(await signatures.actor(laptop, branch).sign(hello))).toBe(true);
  });

  it("with a crisis of its own is honored over an earlier crisis on another branch", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [laptop.key], isCrisis: true, at: 3_000 });
    const people = peopleHavingSeen(crisis, branch);
    expect(await people.honors(await signatures.actor(laptop, branch).sign(hello))).toBe(true);
    expect(await people.honors(await signatures.actor(wallet, crisis).sign(hello))).toBe(false);
  });
});

describe("what a signature signs", () => {
  it("is the signed identity it names, not only its root and the index of its agent", async () => {
    const [root, agent] = [signer(ed25519), signer(ed25519, 3)];
    const signedIdentity = await publish(root, { agents: [agent.key, key(ed25519, 2)] });
    const other = await publish(root, { agents: [agent.key] });
    const signature = await signatures.actor(agent, signedIdentity).sign(hello);
    expect((await verified(signature.bytes, identityOf(signature))).link).toBe(signature.link);
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
    const signature = await signatures.actor(signer(ed25519), signedIdentity).sign(hello);
    const recast = rewritten(signature, {
      object: new LinkValue(signedIdentity.identity.link),
      signature: signedIdentity.signature,
    });
    await expect(verified(recast, byLink(signedIdentity))).rejects.toThrow(/does not verify/);
  });
});

describe("the selection of the signatures over objects of a schema", () => {
  const notes = signatures.selectionOver(note);
  const holding = (...objects: readonly { readonly link: Link<unknown>; readonly bytes: Uint8Array }[]) =>
    new Map(objects.map(({ link, bytes }) => [link, bytes]));

  it("reads a signature over an object of the schema with the object", async () => {
    const signature = await sign(hello, signer(ed25519));
    const read = await notes.read(signature.link, holding(signature, hello));
    expect(read?.signature.link).toBe(signature.link);
    expect(read?.signature.data).toEqual(dataOf(signature));
    expect(read?.object.link).toBe(hello.link);
    expect(read?.object.data).toEqual({ text: "hello" });
  });

  it("leaves out a signature over an object of another schema, and what is not a signature", async () => {
    const card = encodeObject(schema("Card", { name: string() }), { name: "Alice" });
    const signature = await sign(card, signer(ed25519));
    expect(await notes.read(signature.link, holding(signature, card))).toBeUndefined();
    expect(await notes.read(hello.link, holding(hello))).toBeUndefined();
  });

  it("takes a signature that does not verify", async () => {
    const signature = await sign(hello, signer(ed25519));
    const bytes = rewritten(signature, { object: new LinkValue(goodbye.link) });
    const read = await notes.read(linkOf(bytes), holding({ link: linkOf(bytes), bytes }, goodbye));
    expect(read?.object.link).toBe(goodbye.link);
    await expect(verified(bytes, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("refuses a signature whose object the reader does not give, or which does not fit the schema", async () => {
    const signature = await sign(hello, signer(ed25519));
    await expect(notes.read(signature.link, holding(signature))).rejects.toThrow(/no blob is given/);
    const bytes = objectFormat.encode(new ObjectValue(note.link, { title: "hello" }));
    const unfit = await sign({ link: linkOf(bytes) }, signer(ed25519));
    await expect(notes.read(unfit.link, holding(unfit, { link: linkOf(bytes), bytes }))).rejects.toThrow(
      /does not fit its schema/,
    );
  });
});

describe("an identity actor", () => {
  it("signs as the signed identity it is made for", async () => {
    const signedIdentity = await publish(signer(ed25519));
    const signature = await signatures.actor(signer(ed25519), signedIdentity).sign(hello);
    expect(signature.signedIdentity).toBe(signedIdentity);
    expect(signature.data.signedIdentity.link).toBe(signedIdentity.link);
  });

  it("is not made for a signer that is not the root of its identity nor an agent", async () => {
    const signedIdentity = await publish(signer(ed25519));
    expect(() => signatures.actor(signer(ed25519, 2), signedIdentity)).toThrow(/does not sign for/);
    expect(() => signatures.actor(signer(solanaOffchain), signedIdentity)).toThrow(/does not sign for/);
  });

  it("is made for the root and the agents of its identity", async () => {
    const signedIdentity = await publish(signer(ed25519), { agents: [key(ed25519, 2)] });
    expect(signatures.actor(signer(ed25519), signedIdentity).signedIdentity).toBe(signedIdentity);
    expect(signatures.actor(signer(ed25519, 2), signedIdentity).signedIdentity).toBe(signedIdentity);
    expect(() => signatures.actor(signer(ed25519, 3), signedIdentity)).toThrow(/does not sign for/);
  });

  it("refuses a signature that does not verify for its key", async () => {
    const signedIdentity = await publish(signer(ed25519, 2));
    const wrong: Signer = {
      key: signer(ed25519, 2).key,
      sign: (digest, by) => signer(ed25519).sign(digest, by),
    };
    await expect(signatures.actor(wrong, signedIdentity).sign(hello)).rejects.toThrow(/does not verify/);
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await sign(hello, signer(ed25519));
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(signature.bytes, note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(hello.bytes, signatures.schema)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(note.bytes, signatures.schema)).toThrow();
});

test("the bytes of objects and signatures are linked together, each to its own link", async () => {
  const signature = await sign(hello, signer(ed25519));
  expect([hello.bytes, signature.bytes].map((bytes) => linkOf(bytes))).toEqual([hello.link, signature.link]);
});
