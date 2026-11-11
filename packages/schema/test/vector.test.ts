import { decodeObject, decodeSchema, encodeObject } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { array, boolean, integer, link, optional, schema, schemaRoot, schemaValidator } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// sha256sum. A change to the format changes them.
const rootText = '{"$schema":null,"language":"Estoc Schema"}';
const rootLink = "sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d";
const schemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"agents":{"items":{"type":"link"},"type":"array"},"at":{"type":"integer"},' +
  '"crisis":{"optional":true,"type":"boolean"},"prior":{"optional":true,"type":"link"},"root":{"type":"link"}},' +
  '"title":"Identity"}';
const schemaLink = "sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c";
const objectText =
  '{"$schema":{"$link":"sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c"},' +
  '"agents":[{"$link":"sha256:33e523c9a0d1e82b32332a18b14e63ee6dddcc21ca338562cc3a8c9e6a5db4ed"}],' +
  '"at":1794355200000,"crisis":true,' +
  '"root":{"$link":"sha256:adba1ce1a33040f83f16ac2a8feb77eb34bf925101edda4a5b10e567ba4eb9dc"}}';
const objectLink = "sha256:3b800e25354ec614fafb0809db4c606eb1939ef952e0b49679cefd2de12393a7";

const identity = await schema("Identity", {
  root: link(),
  agents: array(link()),
  at: integer(),
  prior: optional(link()),
  crisis: optional(boolean()),
});
const object = encodeObject(identity, {
  root: { $link: "sha256:adba1ce1a33040f83f16ac2a8feb77eb34bf925101edda4a5b10e567ba4eb9dc" },
  agents: [{ $link: "sha256:33e523c9a0d1e82b32332a18b14e63ee6dddcc21ca338562cc3a8c9e6a5db4ed" }],
  at: 1794355200000,
  crisis: true,
});

describe("the root, an identity schema and an object written to it", () => {
  it("encode to fixed bytes and links", () => {
    expect(new TextDecoder().decode(schemaRoot.bytes)).toBe(rootText);
    expect(schemaRoot.link).toBe(rootLink);
    expect(new TextDecoder().decode(identity.bytes)).toBe(schemaText);
    expect(identity.link).toBe(schemaLink);
    expect(new TextDecoder().decode(object.bytes)).toBe(objectText);
    expect(object.link).toBe(objectLink);
  });

  it("decode from those bytes", async () => {
    const read = await decodeSchema(new TextEncoder().encode(schemaText), schemaValidator);
    expect(read.link).toBe(schemaLink);
    expect(decodeObject(new TextEncoder().encode(objectText), read).link).toBe(objectLink);
  });
});
