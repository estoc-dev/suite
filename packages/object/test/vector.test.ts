import { describe, expect, it } from "vitest";
import { decodeObject, decodeSchema, defaultValidator, encodeObject, encodeSchema } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// sha256sum. A change to the format changes them.
const schemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"audience":{"format":"uri","type":"string"},"nonce":{"type":"string"}},' +
  '"required":["audience","nonce"],"title":"Login","type":"object"}';
const schemaLink = "sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e";
const objectText =
  '{"data":{"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"},' +
  '"schema":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}';
const objectLink = "sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80";

describe("a login schema and an object written to it", () => {
  const schema = encodeSchema(
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

  it("encode to fixed bytes and links", () => {
    expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
    expect(schema.link).toBe(schemaLink);
    expect(new TextDecoder().decode(object.bytes)).toBe(objectText);
    expect(object.link).toBe(objectLink);
  });

  it("decode from those bytes", () => {
    const read = decodeSchema(new TextEncoder().encode(schemaText), defaultValidator);
    expect(read.link).toBe(schemaLink);
    expect(decodeObject(new TextEncoder().encode(objectText), read).link).toBe(objectLink);
  });
});
