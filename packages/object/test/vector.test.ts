import { SoftwareSigner } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, decodeSchema, encodeObject, encodeSchema, identitySchema, loadSignatures, signatureSchema } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// sha256sum; the signature, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const schemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"audience":{"format":"uri","type":"string"},"nonce":{"type":"string"}},' +
  '"required":["audience","nonce"],"title":"Login","type":"object"}';
const schemaLink = "sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e";
const objectText =
  '{"$type":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de";
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},"scheme":{"type":"string"}},' +
  '"required":["publicKey","scheme"],"title":"Identity","type":"object"}';
const identitySchemaLink = "sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1";
const identityText =
  '{"$type":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"}';
const identityLink = "sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c";
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
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c"},' +
  '"object":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"},' +
  '"signature":"13ca07ea915690d48f8ef2689f836614390bf782cd2202ea4aa4e520f1b03b7b' +
  'f7f0fed866dac80182832deed515a44ed0deee3b0d0325f1aca6bb03e97f2c09"}';
const signatureLink = "sha256:07339b1193cde4d8f60205accc36426b14dd6879e607ab95971a2738be4108fb";

const schema = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Login",
    type: "object",
    properties: { audience: { type: "string", format: "uri" }, nonce: { type: "string" } },
    required: ["audience", "nonce"],
    additionalProperties: false,
  },
  defaultValidator,
);
const object = encodeObject(schema, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
const signature = await signatures.sign(object, SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)));

describe("a login schema, an object written to it and an Ed25519 signature over that", () => {
  it("encode to fixed bytes and links, the signature written to the signature schema", async () => {
    const schemaOfIdentities = await encodeSchema(identitySchema, defaultValidator);
    expect(new TextDecoder().decode(schemaOfIdentities.bytes)).toBe(identitySchemaText);
    expect(schemaOfIdentities.link).toBe(identitySchemaLink);
    expect(new TextDecoder().decode(signature.identity.bytes)).toBe(identityText);
    expect(signature.identity.link).toBe(identityLink);
    const schemaOfSignatures = await encodeSchema(signatureSchema, defaultValidator);
    expect(new TextDecoder().decode(schemaOfSignatures.bytes)).toBe(signatureSchemaText);
    expect(schemaOfSignatures.link).toBe(signatureSchemaLink);
    expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
    expect(schema.link).toBe(schemaLink);
    expect(new TextDecoder().decode(object.bytes)).toBe(objectText);
    expect(object.link).toBe(objectLink);
    expect(new TextDecoder().decode(signature.bytes)).toBe(signatureText);
    expect(signature.link).toBe(signatureLink);
  });

  it("decode from those bytes", async () => {
    const read = await decodeSchema(new TextEncoder().encode(schemaText), defaultValidator);
    expect(read.link).toBe(schemaLink);
    expect(decodeObject(new TextEncoder().encode(objectText), read).link).toBe(objectLink);
    const identity = new TextEncoder().encode(identityText);
    expect(identities.check(decodeObject(identity, identities.schema)).link).toBe(identityLink);
    const signature = decodeObject(new TextEncoder().encode(signatureText), signatures.schema);
    expect((await signatures.verify(signature, new Map([[identityLink, identity]]))).link).toBe(signatureLink);
  });
});
