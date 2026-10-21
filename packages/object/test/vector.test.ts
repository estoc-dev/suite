import { SoftwareSigner } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  identities,
  identitySchema,
  sign,
  signatures,
  signatureSchema,
} from "../src/index.ts";

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
  '"schema":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}';
const objectLink = "sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80";
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"},"scheme":{"type":"string"}},' +
  '"required":["publicKey","scheme"],"title":"Identity","type":"object"}';
const identitySchemaLink = "sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1";
const identityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}';
const identityLink = "sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc";
const signatureSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"$ref":"https://estoc.dev/schema/link"},"object":{"$ref":"https://estoc.dev/schema/link"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","object","signature"],"title":"Signature","type":"object"}';
const signatureSchemaLink = "sha256:8f7d89a00e6e281562fa88c0632f6e350b68fe09fdd6f14edcb61e697a9ef777";
const signatureText =
  '{"data":{"identity":"sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc",' +
  '"object":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80",' +
  '"signature":"597af40ffd741eaf60009f405797ac722591b9f2f63966055722a409412bd00d' +
  '0ecfa9ae9d9c0e158301fe20a0b6aefdf25a6078117e4d524493212271b12608"},' +
  '"schema":"sha256:8f7d89a00e6e281562fa88c0632f6e350b68fe09fdd6f14edcb61e697a9ef777"}';
const signatureLink = "sha256:80fe9ed9ebd14b98e20c4feb0e14f9fd673b5d38f0df591430736b59b6158884";

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
const signature = await sign(object, SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)));

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
