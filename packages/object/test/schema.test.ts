import { identityToJson, SoftwareSigner } from "@estoc/identity";
import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  defaultValidator,
  encodeObject,
  encodeSchema,
  type JsonSchema,
  type SchemaValidator,
} from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const IDENTITY = "https://estoc.dev/schema/identity";
const LINK = "https://estoc.dev/schema/link";
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote", () => {
    const schema = encodeSchema({ $schema: DRAFT, type: "string", title: "Name" }, defaultValidator);
    const read = decodeSchema(schema.bytes, defaultValidator);
    expect(read.value).toEqual({ $schema: DRAFT, type: "string", title: "Name" });
    expect(read.link).toBe(schema.link);
  });

  it.each([
    ["an array", "[]"],
    ["a boolean schema", "true"],
    ["a string", `"${DRAFT}"`],
  ])("refuses %s, since a schema is a JSON object", (_, text) => {
    expect(() => decodeSchema(utf8(text), defaultValidator)).toThrow();
  });

  it("refuses a schema that does not name its dialect, whatever the validator", () => {
    const lenient: SchemaValidator = { compile: () => () => [] };
    expect(() => decodeSchema(utf8('{"type":"string"}'), lenient)).toThrow();
    expect(() => decodeSchema(utf8('{"$schema":2020,"type":"string"}'), lenient)).toThrow();
  });

  it("refuses the bytes of an object", () => {
    const anything = encodeSchema({ $schema: DRAFT }, defaultValidator);
    expect(() => decodeSchema(encodeObject(anything, { $schema: DRAFT }).bytes, defaultValidator)).toThrow();
  });
});

describe("the default validator", () => {
  const compiles = (schema: JsonSchema) => () => encodeSchema(schema, defaultValidator);

  it("refuses a dialect other than draft 2020-12", () => {
    expect(compiles({ $schema: "http://json-schema.org/draft-07/schema#", type: "string" })).toThrow();
    expect(compiles({ $schema: `${DRAFT}#`, type: "string" })).toThrow();
  });

  it("refuses a schema with a $ref to a schema outside it", () => {
    expect(compiles({ $schema: DRAFT, $ref: "https://example.com/schema" })).toThrow();
  });

  it("refuses an outside $ref even in a branch no value takes", () => {
    const schema = { $schema: DRAFT, anyOf: [{ type: "string" }, { $ref: "https://example.com/schema" }] };
    expect(compiles(schema)).toThrow();
  });

  it("refuses a $ref to a place the schema does not have", () => {
    expect(compiles({ $schema: DRAFT, $ref: "#/$defs/missing" })).toThrow();
  });

  it("refuses a relative $ref, which would name a document by where it was fetched from", () => {
    expect(compiles({ $schema: DRAFT, $ref: "name.json" })).toThrow();
  });

  it("refuses a schema that takes the $id of a builtin", () => {
    expect(compiles({ $schema: DRAFT, $id: IDENTITY, type: "string" })).toThrow();
  });

  it("follows a $ref within the schema", () => {
    const schema = encodeSchema(
      {
        $schema: DRAFT,
        type: "array",
        items: { $ref: "#/$defs/name" },
        $defs: { name: { type: "string", minLength: 1 } },
      },
      defaultValidator,
    );
    expect(schema.validate(["a", "b"])).toEqual([]);
    expect(schema.validate(["a", ""])).not.toEqual([]);
  });

  it("follows a $ref to the schema's own root", () => {
    const tree = encodeSchema(
      {
        $schema: DRAFT,
        type: "object",
        properties: { children: { type: "array", items: { $ref: "#" } } },
        additionalProperties: false,
      },
      defaultValidator,
    );
    expect(tree.validate({ children: [{ children: [] }] })).toEqual([]);
    expect(tree.validate({ children: [{ name: "x" }] })).not.toEqual([]);
  });

  it("asserts format", () => {
    const date = encodeSchema({ $schema: DRAFT, type: "string", format: "date" }, defaultValidator);
    expect(date.validate("2026-10-19")).toEqual([]);
    expect(date.validate("2026-13-45")).not.toEqual([]);
  });
});

describe("the builtin schemas", () => {
  const contract = encodeSchema(
    {
      $schema: DRAFT,
      type: "object",
      properties: { buyer: { $ref: IDENTITY }, terms: { $ref: LINK } },
      required: ["buyer", "terms"],
      additionalProperties: false,
    },
    defaultValidator,
  );
  const terms = contract.link;

  it.each(["ed25519", "eip191", "solana-offchain"] as const)("take a %s identity in its JSON form", (scheme) => {
    const buyer = identityToJson(SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(1)).identity);
    expect(contract.validate({ buyer, terms })).toEqual([]);
  });

  it("refuse an identity that its JSON form would not read", () => {
    const { publicKey } = identityToJson(SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)).identity);
    for (const buyer of [
      { publicKey, scheme: "eip191" },
      { publicKey, scheme: "ed448" },
      { publicKey: publicKey.toUpperCase(), scheme: "ed25519" },
      { publicKey, scheme: "ed25519", role: "buyer" },
    ]) {
      expect(contract.validate({ buyer, terms })).not.toEqual([]);
    }
  });

  it("refuse a link that is not sha256 and lowercase hex", () => {
    const buyer = identityToJson(SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1)).identity);
    for (const link of [terms.toUpperCase(), terms.slice(0, -1), terms.replace("sha256", "sha512")]) {
      expect(contract.validate({ buyer, terms: link })).not.toEqual([]);
    }
  });
});

describe("a validator other than the default", () => {
  const offered: string[] = [];
  const evenOnly: SchemaValidator = {
    compile(_, builtins) {
      offered.push(...builtins.keys());
      return (data) => (typeof data === "number" && data % 2 !== 0 ? ["odd"] : []);
    },
  };
  const even = encodeSchema({ $schema: "https://example.com/even" }, evenOnly);

  it("is offered the builtin schemas", () => {
    expect(offered).toEqual([IDENTITY, LINK]);
  });

  it("decides what an object may hold, when encoding and when decoding", () => {
    expect(encodeObject(even, 2).data).toBe(2);
    expect(() => encodeObject(even, 3)).toThrow();
    const anything = decodeSchema(even.bytes, { compile: () => () => [] });
    const odd = encodeObject(anything, 3);
    expect(() => decodeObject(odd.bytes, even)).toThrow();
  });

  it("refusing to compile a schema leaves no schema", () => {
    const refusing: SchemaValidator = {
      compile() {
        throw new Error("unsupported");
      },
    };
    expect(() => encodeSchema({ $schema: DRAFT }, refusing)).toThrow();
    expect(() => decodeSchema(even.bytes, refusing)).toThrow();
  });
});

test("the same bytes read by two validators give one link", () => {
  const bytes = encodeSchema({ $schema: DRAFT, type: "integer" }, defaultValidator).bytes;
  const lenient = decodeSchema(bytes, { compile: () => () => [] });
  expect(lenient.link).toBe(decodeSchema(bytes, defaultValidator).link);
  expect(lenient.validate("not an integer")).toEqual([]);
});
