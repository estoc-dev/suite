import { identityToJson, SoftwareSigner, type Scheme, type Signer } from "@estoc/identity";
import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { encodeJson, type JsonObject } from "../src/encoding.ts";
import {
  decodeObject,
  decodeSignature,
  encodeObject,
  encodeSchema,
  linkOf,
  sign,
  signatureSchema,
  type Signature,
} from "../src/index.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const parsed = (signature: Signature) =>
  JSON.parse(new TextDecoder().decode(signature.bytes)) as { data: JsonObject; schema: string };
const fields = (signature: Signature) => parsed(signature).data;
const written = (signature: Signature, data: JsonObject) => encodeJson({ data, schema: parsed(signature).schema });
const rewritten = (signature: Signature, change: JsonObject) => written(signature, { ...fields(signature), ...change });

const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello");
const goodbye = encodeObject(note, "goodbye");
const schemes: Scheme[] = ["ed25519", "eip191", "solana-offchain"];

describe("a signature", () => {
  it.each(schemes)("by a %s identity reads back with its identity and object", async (scheme) => {
    const by = signer(scheme);
    const signature = await sign(hello, by);
    const read = decodeSignature(signature.bytes);
    expect(read.identity).toEqual(by.identity);
    expect(read.object).toBe(hello.link);
    expect(read.signature).toEqual(signature.signature);
    expect(read.link).toBe(signature.link);
  });

  it("is refused when its signature is changed", async () => {
    const signature = await sign(hello, signer("ed25519"));
    const hex = fields(signature).signature as string;
    const changed = `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
    expect(() => decodeSignature(rewritten(signature, { signature: changed }))).toThrow();
  });

  it("is refused when it names another identity, even the same key in another scheme", async () => {
    const signature = await sign(hello, signer("ed25519"));
    const { publicKey } = identityToJson(signer("ed25519").identity);
    for (const identity of [identityToJson(signer("ed25519", 2).identity), { publicKey, scheme: "solana-offchain" }]) {
      expect(() => decodeSignature(rewritten(signature, { identity }))).toThrow();
    }
  });

  it("is refused when it names another object", async () => {
    const signature = await sign(hello, signer("eip191"));
    expect(() => decodeSignature(rewritten(signature, { object: goodbye.link }))).toThrow();
  });

  it.each<[string, (fields: JsonObject) => JsonObject]>([
    ["its signature in uppercase hex", (f) => ({ ...f, signature: (f.signature as string).toUpperCase() })],
    ["its object's link in uppercase hex", (f) => ({ ...f, object: `sha256:${(f.object as string).slice(7).toUpperCase()}` })],
    ["a field besides identity, object and signature", (f) => ({ ...f, role: "buyer" })],
    ["no signature", ({ signature: _, ...f }) => f],
    ["an object that is not a link", (f) => ({ ...f, object: "hello" })],
  ])("is refused with %s", async (_, change) => {
    const signature = await sign(hello, signer("ed25519"));
    expect(() => decodeSignature(written(signature, change(fields(signature))))).toThrow();
  });

  it.each<[string, (signature: Signature) => Uint8Array]>([
    ["written to another schema", (signature) => encodeJson({ data: fields(signature), schema: note.link })],
    ["with a field besides data and schema", (signature) => encodeJson({ ...parsed(signature), role: "buyer" })],
    ["with its fields bare, outside data", (signature) => encodeJson(fields(signature))],
  ])("is refused as an object %s", async (_, change) => {
    const signature = await sign(hello, signer("ed25519"));
    expect(() => decodeSignature(change(signature))).toThrow();
  });

  it("is refused in any but the canonical form", async () => {
    const signature = await sign(hello, signer("ed25519"));
    expect(() => decodeSignature(utf8(JSON.stringify(parsed(signature), null, 1)))).toThrow();
  });

  it("reads as an object written to the signature schema, which does not verify it", async () => {
    const schema = await encodeSchema(signatureSchema, defaultValidator);
    for (const scheme of schemes) {
      const signature = await sign(hello, signer(scheme));
      // Without its label, as bytes read from a file or the network have none.
      const bytes: Uint8Array = signature.bytes;
      expect(decodeObject(bytes, schema).link).toBe(signature.link);
    }
    const unverified = rewritten(await sign(hello, signer("ed25519")), { object: goodbye.link });
    expect(decodeObject(unverified, schema).data).toMatchObject({ object: goodbye.link });
    expect(() => decodeSignature(unverified)).toThrow();
  });
});

describe("sign", () => {
  it("refuses a signer whose signature does not verify for its identity", async () => {
    const wrong: Signer = { identity: signer("ed25519", 2).identity, sign: (digest) => signer("ed25519").sign(digest) };
    await expect(sign(hello, wrong)).rejects.toThrow();
  });
});

test("a signature's bytes do not read as an object of another schema, nor an object's as a signature", async () => {
  const signature = await sign(hello, signer("ed25519"));
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(signature.bytes, note)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeSignature(hello.bytes)).toThrow();
  // @ts-expect-error: refused at compile time too
  expect(() => decodeSignature(note.bytes)).toThrow();
});

test("the bytes of objects and signatures are linked together, each to its own link", async () => {
  const signature = await sign(hello, signer("ed25519"));
  expect([hello.bytes, signature.bytes].map((bytes) => linkOf(bytes))).toEqual([hello.link, signature.link]);
});
