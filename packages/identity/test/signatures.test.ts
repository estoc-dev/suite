import {
  decodeObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  type JsonSchemaValidator,
  json,
  linkOf,
  type Reader,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test, vi } from "vitest";
import {
  type IdentityObject,
  loadSignatures,
  type Scheme,
  type Signature,
  type Signatures,
  type Signer,
  SoftwareSigner,
  signatureSchema,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;
const verifiedBy = async (by: Signatures, bytes: Uint8Array, blobs: Reader = new Map()) =>
  by.verify(decodeObject(bytes, by.schema), blobs);
const verified = (bytes: Uint8Array, blobs?: Reader) => verifiedBy(signatures, bytes, blobs);

const utf8 = (text: string) => new TextEncoder().encode(text);
const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const fieldsOf = (object: { readonly bytes: Uint8Array }) => json.fields(json.decode(object.bytes));
const dataOf = (object: { readonly bytes: Uint8Array }) => fieldsOf(object).data;
const written = (signature: Signature, data: JsonObject) => json.encode(json.object(data, fieldsOf(signature).schema));
const rewritten = (signature: Signature, change: JsonObject) => written(signature, { ...dataOf(signature), ...change });
const byLink = (...identities: IdentityObject[]) =>
  new Map(identities.flatMap(({ blobs }) => blobs).map((bytes) => [linkOf(bytes), bytes]));
const identityOf = (signature: Signature) => byLink(signature.identity);

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
    const signature = await signatures.sign(hello, by);
    const read = await verified(signature.bytes, identityOf(signature));
    expect(read.identity).toEqual(identities.encode(by.key));
    expect(read.object).toBe(hello.link);
    expect(read.signature).toEqual(signature.signature);
    expect(read.link).toBe(signature.link);
  });

  it("is refused when its signature is changed", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    const hex = dataOf(signature).signature as string;
    const changed = `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
    await expect(verified(rewritten(signature, { signature: changed }), identityOf(signature))).rejects.toThrow();
  });

  it("is refused when it names another identity, even the same key in another scheme", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    const { publicKey } = signer("ed25519").key;
    for (const other of [
      identities.encode(signer("ed25519", 2).key),
      identities.encode({ publicKey, scheme: "solana-offchain" }),
    ]) {
      await expect(verified(rewritten(signature, { identity: { $link: other.link } }), byLink(other))).rejects.toThrow(
        /does not verify/,
      );
    }
  });

  it("is refused when it names another object", async () => {
    const signature = await signatures.sign(hello, signer("eip191"));
    await expect(
      verified(rewritten(signature, { object: { $link: goodbye.link } }), identityOf(signature)),
    ).rejects.toThrow();
  });

  it("is refused without the blobs of its identity", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    await expect(verified(signature.bytes)).rejects.toThrow(/no blob is given/);
  });

  it.each<[string, (fields: JsonObject) => JsonObject]>([
    ["its signature in uppercase hex", (f) => ({ ...f, signature: (f.signature as string).toUpperCase() })],
    [
      "its object's link in uppercase hex",
      (f) => ({ ...f, object: { $link: `sha256:${hello.link.slice(7).toUpperCase()}` } }),
    ],
    ["its object's link as a bare string", (f) => ({ ...f, object: hello.link })],
    ["a field besides identity, object and signature", (f) => ({ ...f, role: "buyer" })],
    ["no signature", ({ signature: _, ...f }) => f],
    ["an object named by something other than a link", (f) => ({ ...f, object: { $link: "hello" } })],
    [
      "its identity written in place of the link to it",
      (f) => ({ ...f, identity: dataOf(identities.encode(signer("ed25519").key)) }),
    ],
  ])("is refused with %s", async (_, change) => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    await expect(async () =>
      verified(written(signature, change(dataOf(signature))), identityOf(signature)),
    ).rejects.toThrow();
  });

  it.each<[string, (signature: Signature) => Uint8Array]>([
    ["written to another schema", (signature) => json.encode(json.object(dataOf(signature), note.link))],
    ["without its $describedBy", (signature) => json.encode(dataOf(signature))],
  ])("is refused as an object %s", async (_, change) => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    await expect(verified(change(signature), identityOf(signature))).rejects.toThrow();
  });

  it("is refused in any but the canonical form", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    await expect(
      verified(utf8(JSON.stringify(json.decode(signature.bytes), null, 1)), identityOf(signature)),
    ).rejects.toThrow();
  });

  it("reads as an object written to the signature schema, which does not verify it", async () => {
    const schema = await encodeSchema(signatureSchema, defaultValidator);
    for (const scheme of schemes) {
      const signature = await signatures.sign(hello, signer(scheme));
      // Without its label, as bytes read from a file or the network have none.
      const bytes: Uint8Array = signature.bytes;
      expect(decodeObject(bytes, schema).link).toBe(signature.link);
    }
    const signature = await signatures.sign(hello, signer("ed25519"));
    const unverified = rewritten(signature, { object: { $link: goodbye.link } });
    expect(decodeObject(unverified, schema).data).toMatchObject({ object: { $link: goodbye.link } });
    await expect(verified(unverified, identityOf(signature))).rejects.toThrow(/does not verify/);
  });
});

describe("sign", () => {
  it("refuses a signer whose signature does not verify for its key", async () => {
    const wrong: Signer = { key: signer("ed25519", 2).key, sign: (digest) => signer("ed25519").sign(digest) };
    await expect(signatures.sign(hello, wrong)).rejects.toThrow();
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
    ["identity", /^Identity$/],
    ["root", / key$/],
  ])("refuse a signature whose %s it says does not fit", async (_, title) => {
    const strict = await loadSignatures(refusing(title));
    const signature = await signatures.sign(hello, signer("ed25519"));
    await expect(verifiedBy(strict, signature.bytes, identityOf(signature))).rejects.toThrow(/it does not fit/);
  });

  it.each([
    ["identity", /^Identity$/],
    ["key", / key$/],
  ])("do not ask a signer whose %s it says does not fit", async (_, title) => {
    const strict = await loadSignatures(refusing(title));
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(strict.sign(hello, { key: signer("ed25519").key, sign })).rejects.toThrow(/it does not fit/);
    expect(sign).not.toHaveBeenCalled();
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await signatures.sign(hello, signer("ed25519"));
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(signature.bytes, note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(hello.bytes, signatures.schema)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(note.bytes, signatures.schema)).toThrow();
});

test("the bytes of objects and signatures are linked together, each to its own link", async () => {
  const signature = await signatures.sign(hello, signer("ed25519"));
  expect([hello.bytes, signature.bytes].map((bytes) => linkOf(bytes))).toEqual([hello.link, signature.link]);
});
