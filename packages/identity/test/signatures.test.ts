import {
  decodeObject,
  digestOf,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  type JsonSchemaValidator,
  json,
  type Link,
  linkOf,
  type Reader,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, test, vi } from "vitest";
import {
  type DelegatedIdentityObject,
  loadSignatures,
  type Scheme,
  type Signature,
  type Signatures,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  sameKey,
  signatureSchema,
  signingText,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;
const verifiedBy = async (by: Signatures, bytes: Uint8Array, blobs: Reader = new Map()) =>
  by.verify(decodeObject(bytes, by.schema), blobs);
const verified = (bytes: Uint8Array, blobs?: Reader) => verifiedBy(signatures, bytes, blobs);

const utf8 = (text: string) => new TextEncoder().encode(text);
const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: Scheme, fill = 1) => signer(scheme, fill).key;
const fieldsOf = (object: { readonly bytes: Uint8Array }) => json.fields(json.decode(object.bytes));
const dataOf = (object: { readonly bytes: Uint8Array }) => fieldsOf(object).data;
const written = (signature: Signature, data: JsonObject) => json.encode(json.object(data, fieldsOf(signature).schema));
const rewritten = (signature: Signature, change: JsonObject) => written(signature, { ...dataOf(signature), ...change });
const byLink = (...identities: SignedIdentityObject[]) =>
  new Map(identities.flatMap(({ blobs }) => blobs).map((bytes) => [linkOf(bytes), bytes]));
const identityOf = (signature: Signature) => byLink(signature.signedIdentity);
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await identities.publish(by)).sign(object);

const note: Schema<Json, { readonly text: string }> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  defaultValidator,
);
const hello = encodeObject(note, { text: "hello" });
const goodbye = encodeObject(note, { text: "goodbye" });
const schemes: Scheme[] = ["ed25519", "eip191", "solana-offchain"];

describe("a signature", () => {
  it.each(schemes)("by a %s key reads back with its identity and object", async (scheme) => {
    const by = signer(scheme);
    const signature = await sign(hello, by);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(read.signedIdentity).toEqual(signature.signedIdentity);
    expect(read.signedIdentity.identity).toEqual(identities.encode(by.key));
    expect(read.object).toBe(hello.link);
    expect(read.signature).toEqual(signature.signature);
    expect(read.link).toBe(signature.link);
  });

  it("is refused when its signature is changed", async () => {
    const signature = await sign(hello, signer("ed25519"));
    const hex = dataOf(signature).signature as string;
    const changed = `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
    await expect(verified(rewritten(signature, { signature: changed }), identityOf(signature))).rejects.toThrow();
  });

  it("is refused when it names another identity, even the same key in another scheme", async () => {
    const signature = await sign(hello, signer("ed25519"));
    for (const other of [
      await identities.publish(signer("ed25519", 2)),
      await identities.publish(signer("solana-offchain")),
    ]) {
      await expect(
        verified(rewritten(signature, { signedIdentity: { $link: other.link } }), byLink(other)),
      ).rejects.toThrow(/does not verify/);
    }
  });

  it("is refused when it names another object", async () => {
    const signature = await sign(hello, signer("eip191"));
    await expect(
      verified(rewritten(signature, { object: { $link: goodbye.link } }), identityOf(signature)),
    ).rejects.toThrow();
  });

  it("is refused without the blobs of its identity", async () => {
    const signature = await sign(hello, signer("ed25519"));
    await expect(verified(signature.bytes)).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (fields: JsonObject) => JsonObject]>([
    ["its signature in uppercase hex", (f) => ({ ...f, signature: (f.signature as string).toUpperCase() })],
    [
      "its object's link in uppercase hex",
      (f) => ({ ...f, object: { $link: `sha256:${hello.link.slice(7).toUpperCase()}` } }),
    ],
    ["its object's link as a bare string", (f) => ({ ...f, object: hello.link })],
    ["a field besides signedIdentity, object and signature", (f) => ({ ...f, role: "buyer" })],
    ["no signature", ({ signature: _, ...f }) => f],
    ["an object named by something other than a link", (f) => ({ ...f, object: { $link: "hello" } })],
    [
      "an identity written in place of the link to its signed identity",
      (f) => ({ ...f, signedIdentity: dataOf(identities.encode(signer("ed25519").key)) }),
    ],
    [
      "its identity in place of its signed identity",
      (f) => ({ ...f, signedIdentity: { $link: identities.encode(signer("ed25519").key).link } }),
    ],
  ])("is refused with %s", async (_, change) => {
    const signature = await sign(hello, signer("ed25519"));
    await expect(async () =>
      verified(written(signature, change(dataOf(signature))), identityOf(signature)),
    ).rejects.toThrow();
  });

  it.each<[string, (signature: Signature) => Uint8Array]>([
    ["written to another schema", (signature) => json.encode(json.object(dataOf(signature), note.link))],
    ["without its $describedBy", (signature) => json.encode(dataOf(signature))],
  ])("is refused as an object %s", async (_, change) => {
    const signature = await sign(hello, signer("ed25519"));
    await expect(verified(change(signature), identityOf(signature))).rejects.toThrow();
  });

  it("is refused in any but the canonical form", async () => {
    const signature = await sign(hello, signer("ed25519"));
    await expect(
      verified(utf8(JSON.stringify(json.decode(signature.bytes), null, 1)), identityOf(signature)),
    ).rejects.toThrow();
  });

  it("reads as an object written to the signature schema, which does not verify it", async () => {
    const schema = await encodeSchema(signatureSchema, defaultValidator);
    for (const scheme of schemes) {
      const signature = await sign(hello, signer(scheme));
      // Without its label, as bytes read from a file or the network have none.
      const bytes: Uint8Array = signature.bytes;
      expect(decodeObject(bytes, schema).link).toBe(signature.link);
    }
    const signature = await sign(hello, signer("ed25519"));
    const unverified = rewritten(signature, { object: { $link: goodbye.link } });
    expect(decodeObject(unverified, schema).data).toMatchObject({ object: { $link: goodbye.link } });
    await expect(verified(unverified, identityOf(signature))).rejects.toThrow(/does not verify/);
  });
});

describe("a signature for a Delegated Identity", () => {
  const agentsOf = ({ identity }: SignedIdentityObject) => (identity as DelegatedIdentityObject).agents;

  it("by its second agent reads back with that agent as its key", async () => {
    const signedIdentity = await identities.delegate(signer("ed25519"), [key("ed25519", 2), key("ed25519", 3)]);
    const signature = await signatures.actor(signer("ed25519", 3), signedIdentity).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(read.signedIdentity).toEqual(signedIdentity);
    expect(read.key).toEqual(agentsOf(signedIdentity)[1]);
    expect(read.signature[0]).toBe(1);
    expect(read.signature).toHaveLength(65);
  });

  it("by an agent in another scheme than its root is read in the agent's scheme", async () => {
    const signedIdentity = await identities.delegate(signer("eip191"), [key("ed25519", 2)]);
    const signature = await signatures.actor(signer("ed25519", 2), signedIdentity).sign(hello);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(sameKey(read.key, key("ed25519", 2))).toBe(true);
  });

  it.each<[string, (signature: Uint8Array) => Uint8Array]>([
    ["another agent's index", (signature) => Uint8Array.of(0, ...signature.subarray(1))],
    ["an index past its agents", (signature) => Uint8Array.of(2, ...signature.subarray(1))],
    ["no index", (signature) => signature.subarray(1)],
    ["no bytes", () => new Uint8Array()],
  ])("is refused with %s", async (_, change) => {
    const signedIdentity = await identities.delegate(signer("ed25519"), [key("ed25519", 2), key("ed25519", 3)]);
    const signature = await signatures.actor(signer("ed25519", 3), signedIdentity).sign(hello);
    const bytes = rewritten(signature, { signature: bytesToHex(change(signature.signature)) });
    await expect(verified(bytes, identityOf(signature))).rejects.toThrow(/does not verify/);
  });

  it("made for one identity does not verify for another that lists the same agent", async () => {
    const agent = signer("ed25519", 3);
    const signedIdentity = await identities.delegate(signer("ed25519"), [agent.key]);
    const signature = await signatures.actor(agent, signedIdentity).sign(hello);
    const other = await identities.delegate(signer("ed25519", 2), [agent.key]);
    await expect(
      verified(rewritten(signature, { signedIdentity: { $link: other.link } }), byLink(other)),
    ).rejects.toThrow(/does not verify/);
  });
});

describe("what a signature signs", () => {
  // A wallet that does not sign deterministically, as an EIP-191 wallet need not.
  const randomizing = (secretKey: Uint8Array): Signer => ({
    key: SoftwareSigner.fromSecretKey("eip191", secretKey).key,
    async sign(digest, signedIdentity) {
      const text = new TextEncoder().encode(signingText(digest, signedIdentity));
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${text.length}`);
      return secp256k1.sign(keccak_256(concatBytes(prefix, text)), secretKey, { prehash: false, extraEntropy: true });
    },
  });

  it("is the signed identity it names, not only its identity", async () => {
    const root = randomizing(new Uint8Array(32).fill(1));
    const [signedIdentity, other] = [await identities.publish(root), await identities.publish(root)];
    expect(other.identity.link).toBe(signedIdentity.identity.link);
    expect(other.link).not.toBe(signedIdentity.link);
    const signature = await signatures.actor(root, signedIdentity).sign(hello);
    expect((await verified(signature.bytes, identityOf(signature))).link).toBe(signature.link);
    await expect(
      verified(rewritten(signature, { signedIdentity: { $link: other.link } }), byLink(other)),
    ).rejects.toThrow(/does not verify/);
  });

  it("is not the object alone, as a root signs an identity", async () => {
    const by = signer("ed25519");
    const signature = await sign(hello, by);
    const bare = bytesToHex(await by.sign(digestOf(hello.link)));
    await expect(verified(rewritten(signature, { signature: bare }), identityOf(signature))).rejects.toThrow(
      /does not verify/,
    );
  });

  it("is not met by the root's signature over its identity", async () => {
    const signedIdentity = await identities.publish(signer("ed25519"));
    const signature = await signatures.actor(signer("ed25519"), signedIdentity).sign(hello);
    const recast = rewritten(signature, {
      object: { $link: signedIdentity.identity.link },
      signature: bytesToHex(signedIdentity.signature),
    });
    await expect(verified(recast, byLink(signedIdentity))).rejects.toThrow(/does not verify/);
  });
});

describe("an identity actor", () => {
  it("signs as the signed identity it is made for", async () => {
    const signedIdentity = await identities.publish(signer("ed25519"));
    const signature = await signatures.actor(signer("ed25519"), signedIdentity).sign(hello);
    expect(signature.signedIdentity).toBe(signedIdentity);
    expect(signature.data.signedIdentity.$link).toBe(signedIdentity.link);
  });

  it("is not made for a signer that is not the root of an Identity", async () => {
    const signedIdentity = await identities.publish(signer("ed25519"));
    expect(() => signatures.actor(signer("ed25519", 2), signedIdentity)).toThrow(/does not sign for/);
    expect(() => signatures.actor(signer("solana-offchain"), signedIdentity)).toThrow(/does not sign for/);
  });

  it("is not made for a signer that a Delegated Identity does not list, though it is its root", async () => {
    const signedIdentity = await identities.delegate(signer("ed25519"), [key("ed25519", 2)]);
    expect(() => signatures.actor(signer("ed25519", 3), signedIdentity)).toThrow(/does not sign for/);
    expect(() => signatures.actor(signer("ed25519"), signedIdentity)).toThrow(/does not sign for/);
  });

  it("refuses a signature that does not verify for its key", async () => {
    const signedIdentity = await identities.publish(signer("ed25519", 2));
    const wrong: Signer = {
      key: signer("ed25519", 2).key,
      sign: (digest, by) => signer("ed25519").sign(digest, by),
    };
    await expect(signatures.actor(wrong, signedIdentity).sign(hello)).rejects.toThrow(/does not verify/);
  });
});

describe("signatures loaded with a validator", () => {
  // Answers as the default validator does, except that nothing written to a schema titled `title` fits.
  const refusing = (title: RegExp): JsonSchemaValidator => ({
    ...defaultValidator,
    compile: (schema) =>
      title.test(String(schema.title)) ? Promise.resolve(() => ["it does not fit"]) : defaultValidator.compile(schema),
  });

  it.each([
    ["signed identity", /^Signed Identity$/],
    ["identity", /^Identity$/],
    ["root", / key$/],
  ])("refuse a signature whose %s it says does not fit", async (_, title) => {
    const strict = await loadSignatures(refusing(title));
    const signature = await sign(hello, signer("ed25519"));
    await expect(verifiedBy(strict, signature.bytes, identityOf(signature))).rejects.toThrow(/it does not fit/);
  });

  it.each([
    ["identity", /^Identity$/],
    ["key", / key$/],
  ])("do not ask a signer to publish an identity whose %s it says does not fit", async (_, title) => {
    const strict = await loadSignatures(refusing(title));
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(strict.identities.publish({ key: signer("ed25519").key, sign })).rejects.toThrow(/it does not fit/);
    expect(sign).not.toHaveBeenCalled();
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await sign(hello, signer("ed25519"));
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(signature.bytes, note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(hello.bytes, signatures.schema)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(note.bytes, signatures.schema)).toThrow();
});

test("the bytes of objects and signatures are linked together, each to its own link", async () => {
  const signature = await sign(hello, signer("ed25519"));
  expect([hello.bytes, signature.bytes].map((bytes) => linkOf(bytes))).toEqual([hello.link, signature.link]);
});
