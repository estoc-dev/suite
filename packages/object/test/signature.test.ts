import { SoftwareSigner, type Scheme, type Signer } from "@estoc/identity";
import { describe, expect, it, test, vi } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  json,
  linkOf,
  loadSignatures,
  signatureSchema,
  type IdentityObject,
  type JsonObject,
  type JsonSchemaValidator,
  type Signature,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const utf8 = (text: string) => new TextEncoder().encode(text);
const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const parsed = (object: { readonly bytes: Uint8Array }) =>
  JSON.parse(new TextDecoder().decode(object.bytes)) as { data: JsonObject; schema: JsonObject };
const dataOf = (object: { readonly bytes: Uint8Array }) => parsed(object).data;
const written = (signature: Signature, data: JsonObject) => json.encode({ data, schema: parsed(signature).schema });
const rewritten = (signature: Signature, change: JsonObject) => written(signature, { ...dataOf(signature), ...change });
const byLink = (...identities: IdentityObject[]) => new Map(identities.map(({ link, bytes }) => [link, bytes]));
const identityOf = (signature: Signature) => byLink(signature.identity);

const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello");
const goodbye = encodeObject(note, "goodbye");
const schemes: Scheme[] = ["ed25519", "eip191", "solana-offchain"];

describe("a signature", () => {
  it.each(schemes)("by a %s identity reads back with its identity and object", async (scheme) => {
    const by = signer(scheme);
    const signature = await signatures.sign(hello, by);
    const read = signatures.decode(signature.bytes, identityOf(signature));
    expect(read.identity).toEqual(identities.encode(by.identity));
    expect(read.object).toBe(hello.link);
    expect(read.signature).toEqual(signature.signature);
    expect(read.link).toBe(signature.link);
  });

  it("is refused when its signature is changed", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    const hex = dataOf(signature).signature as string;
    const changed = `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
    expect(() => signatures.decode(rewritten(signature, { signature: changed }), identityOf(signature))).toThrow();
  });

  it("is refused when it names another identity, even the same key in another scheme", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    const { publicKey } = signer("ed25519").identity;
    for (const other of [identities.encode(signer("ed25519", 2).identity), identities.encode({ publicKey, scheme: "solana-offchain" })]) {
      expect(() => signatures.decode(rewritten(signature, { identity: { $link: other.link } }), byLink(other))).toThrow(/does not verify/);
    }
  });

  it("is refused when it names another object", async () => {
    const signature = await signatures.sign(hello, signer("eip191"));
    expect(() => signatures.decode(rewritten(signature, { object: { $link: goodbye.link } }), identityOf(signature))).toThrow();
  });

  it("is refused without the object of its identity", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    expect(() => signatures.decode(signature.bytes)).toThrow(/no blob is given/);
  });

  it.each<[string, (fields: JsonObject) => JsonObject]>([
    ["its signature in uppercase hex", (f) => ({ ...f, signature: (f.signature as string).toUpperCase() })],
    ["its object's link in uppercase hex", (f) => ({ ...f, object: { $link: `sha256:${hello.link.slice(7).toUpperCase()}` } })],
    ["its object's link as a bare string", (f) => ({ ...f, object: hello.link })],
    ["a field besides identity, object and signature", (f) => ({ ...f, role: "buyer" })],
    ["no signature", ({ signature: _, ...f }) => f],
    ["an object named by something other than a link", (f) => ({ ...f, object: { $link: "hello" } })],
    ["its identity written in place of the link to it", (f) => ({ ...f, identity: dataOf(identities.encode(signer("ed25519").identity)) })],
  ])("is refused with %s", async (_, change) => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    expect(() => signatures.decode(written(signature, change(dataOf(signature))), identityOf(signature))).toThrow();
  });

  it.each<[string, (signature: Signature) => Uint8Array]>([
    ["written to another schema", (signature) => json.encode({ data: dataOf(signature), schema: { $link: note.link } })],
    ["with a field besides data and schema", (signature) => json.encode({ ...parsed(signature), role: "buyer" })],
    ["with its fields bare, outside data", (signature) => json.encode(dataOf(signature))],
  ])("is refused as an object %s", async (_, change) => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    expect(() => signatures.decode(change(signature), identityOf(signature))).toThrow();
  });

  it("is refused in any but the canonical form", async () => {
    const signature = await signatures.sign(hello, signer("ed25519"));
    expect(() => signatures.decode(utf8(JSON.stringify(parsed(signature), null, 1)), identityOf(signature))).toThrow();
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
    expect(() => signatures.decode(unverified, identityOf(signature))).toThrow(/does not verify/);
  });
});

describe("sign", () => {
  it("refuses a signer whose signature does not verify for its identity", async () => {
    const wrong: Signer = { identity: signer("ed25519", 2).identity, sign: (digest) => signer("ed25519").sign(digest) };
    await expect(signatures.sign(hello, wrong)).rejects.toThrow();
  });
});

describe("signatures loaded with a validator", () => {
  // Answers as the default validator does, except that no identity fits.
  const noIdentity: JsonSchemaValidator = {
    ...defaultValidator,
    compile: (schema) => (schema.title === "Identity" ? Promise.resolve(() => ["no identity fits"]) : defaultValidator.compile(schema)),
  };

  it("refuse a signature whose identity's object it says does not fit", async () => {
    const strict = await loadSignatures(noIdentity);
    const signature = await signatures.sign(hello, signer("ed25519"));
    expect(() => strict.decode(signature.bytes, identityOf(signature))).toThrow(/no identity fits/);
  });

  it("do not ask a signer whose identity it says does not fit", async () => {
    const strict = await loadSignatures(noIdentity);
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(strict.sign(hello, { identity: signer("ed25519").identity, sign })).rejects.toThrow(/no identity fits/);
    expect(sign).not.toHaveBeenCalled();
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await signatures.sign(hello, signer("ed25519"));
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(signature.bytes, note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => signatures.decode(hello.bytes)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => signatures.decode(note.bytes)).toThrow();
});

test("the bytes of objects and signatures are linked together, each to its own link", async () => {
  const signature = await signatures.sign(hello, signer("ed25519"));
  expect([hello.bytes, signature.bytes].map((bytes) => linkOf(bytes))).toEqual([hello.link, signature.link]);
});
