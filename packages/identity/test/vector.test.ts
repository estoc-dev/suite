import { decodeObject, decodeSchema, encodeSchema, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import {
  identitySchema,
  keySchemas,
  loadSignatures,
  type Scheme,
  SoftwareSigner,
  signatureSchema,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signature, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const keySchemaTexts: Record<Scheme, string> = {
  ed25519:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Ed25519 key","type":"object"}',
  eip191:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{66}$","type":"string"}},' +
    '"required":["publicKey"],"title":"EIP-191 key","type":"object"}',
  "solana-offchain":
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Solana off-chain key","type":"object"}',
};
const keySchemaLinks: Record<Scheme, string> = {
  ed25519: "sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a",
  eip191: "sha256:6c6c1305d002fc53e109e39f756c235002aa3ef320fa55130c4ab4add8381992",
  "solana-offchain": "sha256:95e10cf7924ec3dba9ed03bc8ddd0d41b8215307e8a81d758a0cfd1a3b43fc2e",
};
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root"],"title":"Identity","type":"object"}';
const identitySchemaLink = "sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526";
const keyText =
  '{"$describedBy":{"$link":"sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22";
const identityText =
  '{"$describedBy":{"$link":"sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526"},' +
  '"root":{"$link":"sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22"}}';
const identityLink = "sha256:dd31cd36c973940ddcfe6e5a688cf5d33b887b2693d82bae6b9fd359cabda364";
const signatureSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"object":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","object","signature"],"title":"Signature","type":"object"}';
const signatureSchemaLink = "sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5";
const signatureText =
  '{"$describedBy":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:dd31cd36c973940ddcfe6e5a688cf5d33b887b2693d82bae6b9fd359cabda364"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"6c029e975d7ae1f996fe751a8f0df35c068603921b63067ba9e66ddb18f08545' +
  'b36d69a64229c7ec4b0bb2ee45c44e7d79dca56de14b02d2076e318e70cd150e"}';
const signatureLink = "sha256:9d0aa1dea63a8773113fc3b05e24311028b7b73e54bd2efbaaaf4783f6fb0d7c";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test.each(["ed25519", "eip191", "solana-offchain"] as const)(
  "the key schema of %s encodes to fixed bytes and a fixed link",
  async (scheme) => {
    const schema = await encodeSchema(keySchemas[scheme], defaultValidator);
    expect(text(schema.bytes)).toBe(keySchemaTexts[scheme]);
    expect(schema.link).toBe(keySchemaLinks[scheme]);
  },
);

test("the identity schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(identitySchema, defaultValidator);
  expect(text(schema.bytes)).toBe(identitySchemaText);
  expect(schema.link).toBe(identitySchemaLink);
});

test("the signature schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signatureSchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signatureSchemaText);
  expect(schema.link).toBe(signatureSchemaLink);
});

describe("an identity with an Ed25519 root and its signature over the login object of @estoc/object", () => {
  it("encode to fixed bytes and links", async () => {
    const signature = await signatures.sign(
      { link: objectLink },
      SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)),
    );
    expect(text(signature.identity.root.bytes)).toBe(keyText);
    expect(signature.identity.root.link).toBe(keyLink);
    expect(text(signature.identity.bytes)).toBe(identityText);
    expect(signature.identity.link).toBe(identityLink);
    expect(text(signature.bytes)).toBe(signatureText);
    expect(signature.link).toBe(signatureLink);
  });

  it("decode from those bytes", async () => {
    const blobs = new Map([
      [keyLink, utf8(keyText)],
      [identityLink, utf8(identityText)],
    ]);
    const read = await signatures.identities.read(identityLink, blobs);
    expect(read.root.scheme).toBe("ed25519");
    const keySchema = await decodeSchema(utf8(keySchemaTexts.ed25519), defaultValidator);
    expect(decodeObject(utf8(keyText), keySchema).link).toBe(keyLink);
    const schema = await decodeSchema(utf8(identitySchemaText), defaultValidator);
    expect(decodeObject(utf8(identityText), schema).link).toBe(identityLink);
    const signature = decodeObject(utf8(signatureText), signatures.schema);
    expect((await signatures.verify(signature, blobs)).link).toBe(signatureLink);
  });
});
