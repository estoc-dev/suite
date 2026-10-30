import { decodeObject, decodeSchema, encodeSchema, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import {
  identityInterface,
  keyIdentitySchema,
  keyInterface,
  keySchemas,
  loadSignatures,
  type Scheme,
  SoftwareSigner,
  signatureSchema,
  signedIdentitySchema,
} from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signatures, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const keyInterfaceLink = "sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160";
const identityInterfaceLink = "sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f";
const keySchemaTexts: Record<Scheme, string> = {
  ed25519:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Ed25519 key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
  eip191:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{66}$","type":"string"}},' +
    '"required":["publicKey"],"title":"EIP-191 key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
  "solana-offchain":
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Solana off-chain key","type":"object",' +
    '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}',
};
const keySchemaLinks: Record<Scheme, string> = {
  ed25519: "sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662",
  eip191: "sha256:8896cefe124af9a93c39ced7f4190a39a5573928806c256e5af54323a1b38d1a",
  "solana-offchain": "sha256:c0bee18e26838f2864b6e7864e3a81ab41cc9d95a65c47c3d5ae491522236822",
};
const keyIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root"],"title":"Key Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}';
const keyIdentitySchemaLink = "sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362";
const keyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358";
const identityText =
  '{"$describedBy":{"$link":"sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362"},' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const identityLink = "sha256:e36a63b250c8e05258d06aa68b0b1ead71b255ad08a96f426c9ee52ef6e34b99";
const signedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","signature"],"title":"Signed Identity","type":"object"}';
const signedIdentitySchemaLink = "sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa";
const signedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:e36a63b250c8e05258d06aa68b0b1ead71b255ad08a96f426c9ee52ef6e34b99"},' +
  '"signature":"879c083c555339acf377ad210b00c9ea74740e6f197e696baf5f128506eb0927' +
  '4276759c728e131a40270acd15491537fa50f0818301b49c4759f3ba72514c03"}';
const signedIdentityLink = "sha256:85dd9e2207b1a986cde3784d467879bd7d9ce952d70c37acce9dce617a4576d2";
const signatureSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"object":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},' +
  '"signedIdentity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["signedIdentity","object","signature"],"title":"Signature","type":"object"}';
const signatureSchemaLink = "sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135";
const signatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"6c029e975d7ae1f996fe751a8f0df35c068603921b63067ba9e66ddb18f08545' +
  'b36d69a64229c7ec4b0bb2ee45c44e7d79dca56de14b02d2076e318e70cd150e",' +
  '"signedIdentity":{"$link":"sha256:85dd9e2207b1a986cde3784d467879bd7d9ce952d70c37acce9dce617a4576d2"}}';
const signatureLink = "sha256:b836107915964928489dc710ded994b19f7aff1ac3fcae4ee22eb6e9529b09f3";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test.each([
  ["Key", keyInterface, keyInterfaceLink],
  ["Identity", identityInterface, identityInterfaceLink],
] as const)("the %s interface is its name in UTF-8, with a fixed link", (name, { bytes, link }, expected) => {
  expect(text(bytes)).toBe(name);
  expect(link).toBe(expected);
});

test.each(["ed25519", "eip191", "solana-offchain"] as const)(
  "the key schema of %s encodes to fixed bytes and a fixed link",
  async (scheme) => {
    const schema = await encodeSchema(keySchemas[scheme], defaultValidator);
    expect(text(schema.bytes)).toBe(keySchemaTexts[scheme]);
    expect(schema.link).toBe(keySchemaLinks[scheme]);
  },
);

test("the Key Identity schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(keyIdentitySchema, defaultValidator);
  expect(text(schema.bytes)).toBe(keyIdentitySchemaText);
  expect(schema.link).toBe(keyIdentitySchemaLink);
});

test("the signed identity schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signedIdentitySchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signedIdentitySchemaText);
  expect(schema.link).toBe(signedIdentitySchemaLink);
});

test("the signature schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signatureSchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signatureSchemaText);
  expect(schema.link).toBe(signatureSchemaLink);
});

describe("an identity with an Ed25519 root, signed, and its signature over the login object of @estoc/object", () => {
  it("encode to fixed bytes and links", async () => {
    const root = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
    const actor = signatures.actor(root, await signatures.identities.publish(root));
    const signature = await actor.sign({ link: objectLink });
    const { identity } = signature.signedIdentity;
    expect(text(identity.root.bytes)).toBe(keyText);
    expect(identity.root.link).toBe(keyLink);
    expect(text(identity.bytes)).toBe(identityText);
    expect(identity.link).toBe(identityLink);
    expect(text(signature.signedIdentity.bytes)).toBe(signedIdentityText);
    expect(signature.signedIdentity.link).toBe(signedIdentityLink);
    expect(text(signature.bytes)).toBe(signatureText);
    expect(signature.link).toBe(signatureLink);
  });

  it("decode from those bytes", async () => {
    const blobs = new Map([
      [keyLink, utf8(keyText)],
      [identityLink, utf8(identityText)],
      [signedIdentityLink, utf8(signedIdentityText)],
    ]);
    const read = await signatures.identities.readSigned(signedIdentityLink, blobs);
    expect(read.identity.link).toBe(identityLink);
    expect(read.identity.root.scheme).toBe("ed25519");
    const keySchema = await decodeSchema(utf8(keySchemaTexts.ed25519), defaultValidator);
    expect(decodeObject(utf8(keyText), keySchema).link).toBe(keyLink);
    const schema = await decodeSchema(utf8(keyIdentitySchemaText), defaultValidator);
    expect(decodeObject(utf8(identityText), schema).link).toBe(identityLink);
    const signedSchema = await decodeSchema(utf8(signedIdentitySchemaText), defaultValidator);
    expect(decodeObject(utf8(signedIdentityText), signedSchema).link).toBe(signedIdentityLink);
    const signature = decodeObject(utf8(signatureText), signatures.schema);
    expect((await signatures.verify(signature, blobs)).link).toBe(signatureLink);
  });
});
