import { describe, expect, it, test, vi } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  jsonSchema,
  linkSchema,
  type JsonSchema,
  type JsonSchemaValidator,
} from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);
const lenient: JsonSchemaValidator = { language: jsonSchema, compile: async () => () => [] };

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote", async () => {
    const schema = await encodeSchema({ $schema: DRAFT, type: "string", title: "Name" }, defaultValidator);
    const read = await decodeSchema(schema.bytes, defaultValidator);
    expect(jsonSchema.decode(read.bytes)).toEqual({ $schema: DRAFT, type: "string", title: "Name" });
    expect(read.link).toBe(schema.link);
  });

  it.each([
    ["an array", "[]"],
    ["a boolean schema", "true"],
    ["a string", `"${DRAFT}"`],
  ])("refuses %s, since a schema is a JSON object", async (_, text) => {
    await expect(decodeSchema(utf8(text), defaultValidator)).rejects.toThrow();
  });

  it("refuses a schema that does not name its dialect, whatever the validator", async () => {
    await expect(decodeSchema(utf8('{"type":"string"}'), lenient)).rejects.toThrow();
    await expect(decodeSchema(utf8('{"$schema":2020,"type":"string"}'), lenient)).rejects.toThrow();
  });

  it("refuses the bytes of an object", async () => {
    const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
    // @ts-expect-error: refused at compile time too
    await expect(decodeSchema(encodeObject(anything, { $schema: DRAFT }).bytes, defaultValidator)).rejects.toThrow();
  });
});

describe("the default validator", () => {
  const compile = (schema: JsonSchema) => encodeSchema(schema, defaultValidator);

  it("refuses a dialect other than draft 2020-12", async () => {
    await expect(compile({ $schema: "http://json-schema.org/draft-07/schema#", type: "string" })).rejects.toThrow();
    await expect(compile({ $schema: `${DRAFT}#`, type: "string" })).rejects.toThrow();
  });

  it("refuses a schema resource inside the schema in another dialect", async () => {
    for (const dialect of ["http://json-schema.org/draft-07/schema#", "https://example.com/unsupported-dialect"]) {
      const child = { $id: "https://example.com/child", $schema: dialect, type: "string" };
      await expect(compile({ $schema: DRAFT, $ref: "https://example.com/child", $defs: { child } })).rejects.toThrow();
    }
  });

  it("reads a schema resource inside the schema that names no dialect as draft 2020-12", async () => {
    const child = { $id: "https://example.com/child", prefixItems: [{ type: "string" }] };
    const pair = await compile({ $schema: DRAFT, $ref: "https://example.com/child", $defs: { child } });
    expect(pair.validate(["a"])).toEqual([]);
    expect(pair.validate([1])).not.toEqual([]);
  });

  it("refuses a schema that its dialect's meta-schema refuses", async () => {
    await expect(compile({ $schema: DRAFT, type: 5 })).rejects.toThrow();
  });

  it("refuses a schema with a $ref to a schema outside it, without fetching it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      await expect(compile({ $schema: DRAFT, $ref: "https://example.com/schema" })).rejects.toThrow();
      await expect(compile({ $schema: DRAFT, $ref: "file:///etc/schema.json" })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("refuses an outside $ref even in a branch no value takes", async () => {
    await expect(compile({ $schema: DRAFT, anyOf: [{ type: "string" }, { $ref: "https://example.com/schema" }] })).rejects.toThrow();
  });

  it("refuses a $ref to the meta-schema, which it has but the schema does not", async () => {
    await expect(compile({ $schema: DRAFT, $ref: DRAFT })).rejects.toThrow();
  });

  it("refuses a $ref to a place the schema does not have", async () => {
    await expect(compile({ $schema: DRAFT, $ref: "#/$defs/missing" })).rejects.toThrow();
  });

  it("refuses a relative $ref, which would name a document by where it was fetched from", async () => {
    await expect(compile({ $schema: DRAFT, $ref: "name.json" })).rejects.toThrow();
  });

  it("refuses a schema that takes the $id of the meta-schema", async () => {
    await expect(compile({ $schema: DRAFT, $id: DRAFT, type: "string" })).rejects.toThrow();
    await expect(compile({ $schema: DRAFT, $ref: DRAFT, $defs: { own: { $id: DRAFT, type: "number" } } })).rejects.toThrow();
  });

  it("follows a $ref by the keyword alone, whatever other members name", async () => {
    const outside = { $schema: DRAFT, $ref: "https://example.com/schema", $defs: { allow: true } };
    await expect(compile({ ...outside, __absolute_ref__: "urn:estoc:schema#/$defs/allow" })).rejects.toThrow();
    const deny = await compile({
      $schema: DRAFT,
      $ref: "#/$defs/deny",
      $defs: { deny: false, allow: true },
      __absolute_ref__: "urn:estoc:schema#/$defs/allow",
    });
    expect(deny.validate(42)).not.toEqual([]);
  });

  it("follows a $ref within the schema", async () => {
    const schema = await compile({
      $schema: DRAFT,
      type: "array",
      items: { $ref: "#/$defs/name" },
      $defs: { name: { type: "string", minLength: 1 } },
    });
    expect(schema.validate(["a", "b"])).toEqual([]);
    expect(schema.validate(["a", ""])).not.toEqual([]);
  });

  it.each([
    ["#", {}],
    ["", { $id: "https://example.com/tree" }],
  ])("follows a $ref of %j to the schema's own root", async ($ref, id) => {
    const tree = await compile({
      $schema: DRAFT,
      ...id,
      type: "object",
      properties: { children: { type: "array", items: { $ref } } },
      additionalProperties: false,
    });
    expect(tree.validate({ children: [{ children: [] }] })).toEqual([]);
    expect(tree.validate({ children: [{ name: "x" }] })).not.toEqual([]);
  });

  it("follows a $dynamicRef", async () => {
    const tree = await compile({
      $schema: DRAFT,
      $id: "https://example.com/tree",
      $dynamicAnchor: "node",
      type: "object",
      properties: { children: { type: "array", items: { $dynamicRef: "#node" } } },
    });
    expect(tree.validate({ children: [{ children: [] }] })).toEqual([]);
    expect(tree.validate({ children: [42] })).not.toEqual([]);
  });

  it("reads only the members a value has", async () => {
    const optional = await compile({ $schema: DRAFT, type: "object", properties: { constructor: { type: "string" } } });
    expect(optional.validate({})).toEqual([]);
    expect(optional.validate({ constructor: "x" })).toEqual([]);
    expect(optional.validate({ constructor: 1 })).not.toEqual([]);
    const required = await compile({ $schema: DRAFT, type: "object", required: ["constructor"] });
    expect(required.validate({})).not.toEqual([]);
  });

  it("asserts format", async () => {
    const date = await compile({ $schema: DRAFT, type: "string", format: "date" });
    expect(date.validate("2026-10-19")).toEqual([]);
    expect(date.validate("2026-13-45")).not.toEqual([]);
  });

  it("compiles schemas one at a time, so that one cannot reach another", async () => {
    const [named, reaching, unrelated] = await Promise.allSettled([
      compile({ $schema: DRAFT, $id: "https://example.com/named", type: "string" }),
      compile({ $schema: DRAFT, $ref: "https://example.com/named" }),
      compile({ $schema: DRAFT, type: "number" }),
    ]);
    expect([named.status, reaching.status, unrelated.status]).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("forgets a schema once compiled, whether or not it compiled", async () => {
    const id = "https://example.com/again";
    await expect(compile({ $schema: DRAFT, $id: id, $ref: "#/$defs/missing" })).rejects.toThrow();
    await compile({ $schema: DRAFT, $id: id, type: "string" });
    await compile({ $schema: DRAFT, $id: id, type: "number" });
    await expect(compile({ $schema: DRAFT, $ref: id })).rejects.toThrow();
  });
});

const contract = await encodeSchema(
  {
    $schema: DRAFT,
    type: "object",
    properties: { terms: linkSchema },
    required: ["terms"],
    additionalProperties: false,
  },
  defaultValidator,
);
const terms = contract.link;

describe("linkSchema", () => {
  it("takes a link", () => {
    expect(contract.validate({ terms: { $link: terms } })).toEqual([]);
  });

  it("refuses a link that is not sha256 and lowercase hex", () => {
    for (const link of [terms.toUpperCase(), terms.slice(0, -1), terms.replace("sha256", "sha512")]) {
      expect(contract.validate({ terms: { $link: link } })).not.toEqual([]);
    }
  });

  it("refuses a link written as a bare string, or with a member besides $link", () => {
    expect(contract.validate({ terms })).not.toEqual([]);
    expect(contract.validate({ terms: { $link: terms, note: "x" } })).not.toEqual([]);
  });
});

const evenOnly: JsonSchemaValidator = {
  language: jsonSchema,
  async compile() {
    return (data) => (typeof data === "number" && data % 2 !== 0 ? ["odd"] : []);
  },
};
const even = await encodeSchema({ $schema: "https://example.com/even" }, evenOnly);

describe("a validator other than the default", () => {
  it("decides what an object may hold, when encoding and when decoding", async () => {
    expect(encodeObject(even, 2).data).toBe(2);
    expect(() => encodeObject(even, 3)).toThrow();
    const anything = await decodeSchema(even.bytes, lenient);
    const odd = encodeObject(anything, 3);
    expect(() => decodeObject(odd.bytes, even)).toThrow();
  });

  it("refusing to compile a schema leaves no schema", async () => {
    const refusing: JsonSchemaValidator = {
      language: jsonSchema,
      async compile() {
        throw new Error("unsupported");
      },
    };
    await expect(encodeSchema({ $schema: DRAFT }, refusing)).rejects.toThrow();
    await expect(decodeSchema(even.bytes, refusing)).rejects.toThrow();
  });
});

test("the same bytes read by two validators give one link", async () => {
  const bytes = (await encodeSchema({ $schema: DRAFT, type: "integer" }, defaultValidator)).bytes;
  const read = await decodeSchema(bytes, lenient);
  expect(read.link).toBe((await decodeSchema(bytes, defaultValidator)).link);
  expect(read.validate("not an integer")).toEqual([]);
});
