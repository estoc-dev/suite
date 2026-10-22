import { SoftwareSigner } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  identitySchema,
  loadSignatures,
  signatureSchema,
} from "../src/index.ts";

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
  '{"data":{"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"},' +
  '"schema":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}}';
const objectLink = "sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52";
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},"scheme":{"type":"string"}},' +
  '"required":["publicKey","scheme"],"title":"Identity","type":"object"}';
const identitySchemaLink = "sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1";
const identityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}}';
const identityLink = "sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53";
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
  '{"data":{"identity":{"$link":"sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53"},' +
  '"object":{"$link":"sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52"},' +
  '"signature":"bc44d93c9596131d6723e9c749b910648918af6a3cdb6e4c9e493f62be3b1edf' +
  '84159319aa8ec050291690c57ef99ffb788d7c86d90fb3851bed43ce0d11aa02"},' +
  '"schema":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"}}';
const signatureLink = "sha256:b6799e6f181e8d164164bef5e33aec18bf7cc8c7e152d58652c0d0b45ccacd5f";

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
    expect(identities.decode(identity).link).toBe(identityLink);
    expect(signatures.decode(new TextEncoder().encode(signatureText), new Map([[identityLink, identity]])).link).toBe(signatureLink);
  });
});
