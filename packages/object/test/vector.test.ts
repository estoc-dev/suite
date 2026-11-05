import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, decodeSchema, encodeObject, encodeSchema, jsonSchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// sha256sum. A change to the format changes them.
const rootText = '{"$schema":null,"language":"JSON Schema"}';
const rootLink = "sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326";
const schemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"audience":{"format":"uri","type":"string"},"nonce":{"type":"string"}},' +
  '"required":["audience","nonce"],"title":"Login","type":"object"}}';
const schemaLink = "sha256:cf76929b1ed8423c16a19e6dc435f82e007bcff00c2020c94abbb4ad73e97eb0";
const objectText =
  '{"$schema":{"$link":"sha256:cf76929b1ed8423c16a19e6dc435f82e007bcff00c2020c94abbb4ad73e97eb0"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4";

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

describe("the root of JSON Schema, a login schema and an object written to it", () => {
  it("encode to fixed bytes and links", () => {
    expect(new TextDecoder().decode(jsonSchema.root.bytes)).toBe(rootText);
    expect(jsonSchema.root.link).toBe(rootLink);
    expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
    expect(schema.link).toBe(schemaLink);
    expect(new TextDecoder().decode(object.bytes)).toBe(objectText);
    expect(object.link).toBe(objectLink);
  });

  it("decode from those bytes", async () => {
    const read = await decodeSchema(new TextEncoder().encode(schemaText), defaultValidator);
    expect(read.link).toBe(schemaLink);
    expect(decodeObject(new TextEncoder().encode(objectText), read).link).toBe(objectLink);
  });
});
