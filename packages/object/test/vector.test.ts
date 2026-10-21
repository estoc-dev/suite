import { SoftwareSigner } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, decodeSchema, encodeObject, encodeSchema, sign, signatures, signatureSchema } from "../src/index.ts";

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
const signatureSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"$ref":"https://estoc.dev/schema/identity"},"object":{"$ref":"https://estoc.dev/schema/link"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","object","signature"],"title":"Signature","type":"object"}';
const signatureSchemaLink = "sha256:6d956bb1d013b40941c5a82d604106f8c2766ec7a24dfdcd1bec60af3c97bd6e";
const signatureText =
  '{"data":{"identity":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"object":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80",' +
  '"signature":"597af40ffd741eaf60009f405797ac722591b9f2f63966055722a409412bd00d' +
  '0ecfa9ae9d9c0e158301fe20a0b6aefdf25a6078117e4d524493212271b12608"},' +
  '"schema":"sha256:6d956bb1d013b40941c5a82d604106f8c2766ec7a24dfdcd1bec60af3c97bd6e"}';
const signatureLink = "sha256:be68fa2ca85439ce9431a5498fa7af233fe9472be18b160bff69f71fe7a6672c";

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
    expect(signatures.decode(new TextEncoder().encode(signatureText)).link).toBe(signatureLink);
  });
});
