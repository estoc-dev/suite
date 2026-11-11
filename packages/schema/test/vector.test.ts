import { decodeObject, decodeSchema, encodeObject } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { array, boolean, integer, link, optional, schema, schemaValidator } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// sha256sum. A change to the format changes them.
const schemaText =
  '{"fields":{"agents":{"items":{"type":"link"},"type":"array"},"at":{"type":"integer"},' +
  '"crisis":{"optional":true,"type":"boolean"},"prior":{"optional":true,"type":"link"},' +
  '"root":{"type":"link"}},"title":"Identity"}';
const schemaLink = "sha256:dfecb045e117ef19e5b70e67681d952a8ddb3d64dd8151814439681439a33c16";
const objectText =
  '{"$schema":{"$link":"sha256:dfecb045e117ef19e5b70e67681d952a8ddb3d64dd8151814439681439a33c16"},' +
  '"agents":[{"$link":"sha256:33e523c9a0d1e82b32332a18b14e63ee6dddcc21ca338562cc3a8c9e6a5db4ed"}],' +
  '"at":1794355200000,"crisis":true,' +
  '"root":{"$link":"sha256:adba1ce1a33040f83f16ac2a8feb77eb34bf925101edda4a5b10e567ba4eb9dc"}}';
const objectLink = "sha256:482c8e0ba71f8cd7ca98f3d1fc6652f98a27fac4262e1e71a967ce9a4e907c7a";

const identity = schema("Identity", {
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

describe("an identity schema and an object written to it", () => {
  it("encode to fixed bytes and links", () => {
    expect(new TextDecoder().decode(identity.bytes)).toBe(schemaText);
    expect(identity.link).toBe(schemaLink);
    expect(new TextDecoder().decode(object.bytes)).toBe(objectText);
    expect(object.link).toBe(objectLink);
  });

  it("decode from those bytes", () => {
    const read = decodeSchema(new TextEncoder().encode(schemaText), schemaValidator);
    expect(read.link).toBe(schemaLink);
    expect(decodeObject(new TextEncoder().encode(objectText), read).link).toBe(objectLink);
  });
});
