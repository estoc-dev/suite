import { decodeObject, decodeSchema, encodeSchema, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import { identitySchemas, loadSignatures, type Scheme, SoftwareSigner, signatureSchema } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib; the signature, which Ed25519 makes deterministic, against
// Python's cryptography package. A change to the format changes them.
const identitySchemaTexts: Record<Scheme, string> = {
  ed25519:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Ed25519 identity","type":"object"}',
  eip191:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{66}$","type":"string"}},' +
    '"required":["publicKey"],"title":"EIP-191 identity","type":"object"}',
  "solana-offchain":
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
    '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
    '"required":["publicKey"],"title":"Solana off-chain identity","type":"object"}',
};
const identitySchemaLinks: Record<Scheme, string> = {
  ed25519: "sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5",
  eip191: "sha256:07fd8b8cec12b6d2d7b71eb8458fa07b39d3ff0af597d3d1809087489d10d78c",
  "solana-offchain": "sha256:638178eb4d10567b84a05d2a073dac2f72cd581a17880b83d00107bb73994961",
};
const identityText =
  '{"$type":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const identityLink = "sha256:25c90970d2a76cc7223d47405f04ec51fd5e0194020014bd6816652bc94383b8";
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
  '"identity":{"$link":"sha256:25c90970d2a76cc7223d47405f04ec51fd5e0194020014bd6816652bc94383b8"},' +
  '"object":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"},' +
  '"signature":"13ca07ea915690d48f8ef2689f836614390bf782cd2202ea4aa4e520f1b03b7b' +
  'f7f0fed866dac80182832deed515a44ed0deee3b0d0325f1aca6bb03e97f2c09"}';
const signatureLink = "sha256:2821c6e9629b6f3aaf33acec1ec094577a8ee1cea259f60dfd22e9cbdf9effa2";

// The login object of the vector in @estoc/object.
const objectLink: Link<never> = "sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test.each(["ed25519", "eip191", "solana-offchain"] as const)(
  "the identity schema of %s encodes to fixed bytes and a fixed link",
  async (scheme) => {
    const schema = await encodeSchema(identitySchemas[scheme], defaultValidator);
    expect(text(schema.bytes)).toBe(identitySchemaTexts[scheme]);
    expect(schema.link).toBe(identitySchemaLinks[scheme]);
  },
);

test("the signature schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(signatureSchema, defaultValidator);
  expect(text(schema.bytes)).toBe(signatureSchemaText);
  expect(schema.link).toBe(signatureSchemaLink);
});

describe("an Ed25519 identity and its signature over the login object of @estoc/object", () => {
  it("encode to fixed bytes and links", async () => {
    const signature = await signatures.sign(
      { link: objectLink },
      SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)),
    );
    expect(text(signature.identity.bytes)).toBe(identityText);
    expect(signature.identity.link).toBe(identityLink);
    expect(text(signature.bytes)).toBe(signatureText);
    expect(signature.link).toBe(signatureLink);
  });

  it("decode from those bytes", async () => {
    const identity = utf8(identityText);
    const read = await signatures.identities.read(identityLink, new Map([[identityLink, identity]]));
    expect(read.scheme).toBe("ed25519");
    const schema = await decodeSchema(utf8(identitySchemaTexts.ed25519), defaultValidator);
    expect(decodeObject(identity, schema).link).toBe(identityLink);
    const signature = decodeObject(utf8(signatureText), signatures.schema);
    expect((await signatures.verify(signature, new Map([[identityLink, identity]]))).link).toBe(signatureLink);
  });
});
