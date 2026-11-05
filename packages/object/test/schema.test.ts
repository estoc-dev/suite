import { describe, expect, it, test, vi } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchema,
  type JsonSchemaValidator,
  json,
  jsonSchema,
  jsonSchemaRoot,
  linkSchema,
  type Schema,
  type SchemaValidator,
  schemaOf,
} from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);
const lenient: JsonSchemaValidator = { language: jsonSchema, compile: async () => () => [] };

const root = jsonSchemaRoot;
const schemaText = (...members: string[]) => `{${[`"$schema":{"$link":"${root.link}"}`, ...members].join(",")}}`;

describe("the root of JSON Schema", () => {
  it("describes itself, and stands for the language", () => {
    expect(new TextDecoder().decode(root.bytes)).toBe('{"$schema":null,"language":"JSON Schema"}');
    expect(schemaOf(root.bytes, json)).toBe(root.link);
  });

  it("is not a schema", async () => {
    // @ts-expect-error: refused at compile time too
    await expect(decodeSchema(root.bytes, lenient)).rejects.toThrow(/not to itself/);
  });
});

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, an object of the root holding the document", async () => {
    const schema = await encodeSchema({ $schema: DRAFT, type: "string", title: "Name" }, defaultValidator);
    const read = await decodeSchema(schema.bytes, defaultValidator);
    expect(json.decode(read.bytes)).toEqual({
      $schema: { $link: root.link },
      document: { $schema: DRAFT, type: "string", title: "Name" },
    });
    expect(read.link).toBe(schema.link);
  });

  it("reads a schema written out by hand", async () => {
    const text = schemaText(`"document":{"$schema":"${DRAFT}"}`);
    expect(new TextDecoder().decode((await decodeSchema(utf8(text), lenient)).bytes)).toBe(text);
  });

  it.each([
    ["an array", "[]", /names its schema/],
    ["a JSON Schema document on its own, which is bytes", `{"$schema":"${DRAFT}","type":"string"}`, /names its schema/],
    ["an object of the root with no document", schemaText(), /holds a document/],
    [
      "an object of the root holding more than a document",
      schemaText(`"document":{"$schema":"${DRAFT}"}`, '"title":"Name"'),
      /not title/,
    ],
  ])("refuses %s", async (_, text, reason) => {
    await expect(decodeSchema(utf8(text), lenient)).rejects.toThrow(reason);
  });

  it("refuses a document that does not name its dialect, whatever the validator", async () => {
    await expect(decodeSchema(utf8(schemaText('"document":{"type":"string"}')), lenient)).rejects.toThrow();
    await expect(decodeSchema(utf8(schemaText('"document":{"$schema":2020}')), lenient)).rejects.toThrow();
    await expect(decodeSchema(utf8(schemaText('"document":true')), lenient)).rejects.toThrow();
  });

  it("refuses an object of another schema, even one holding a document", async () => {
    const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
    const object = encodeObject(anything, { document: { $schema: DRAFT } });
    // @ts-expect-error: refused at compile time too
    await expect(decodeSchema(object.bytes, defaultValidator)).rejects.toThrow(
      `is written to ${root.link}, not to ${anything.link}`,
    );
  });

  it("refuses a document that holds a link, which would put another blob in the schema's closure", async () => {
    const note = await encodeSchema({ $schema: DRAFT, title: "Note" }, defaultValidator);
    const refusal = `a schema links only to what it is written to, not to ${note.link}`;
    await expect(encodeSchema({ $schema: DRAFT, const: { $link: note.link } }, defaultValidator)).rejects.toThrow(
      refusal,
    );
    const text = schemaText(`"document":{"$schema":"${DRAFT}","x-note":{"$link":"${note.link}"}}`);
    await expect(decodeSchema(utf8(text), lenient)).rejects.toThrow(refusal);
  });
});

describe("the blobs of a schema", () => {
  it("are its closure, the schema and the root of its language, though its data holds links", async () => {
    const schema = await encodeSchema(
      { $schema: DRAFT, type: "object", title: "Note", properties: { to: linkSchema } },
      defaultValidator,
    );
    expect(schema.blobs).toEqual([schema.bytes, root.bytes]);
    expect([...json.links(json.decode(schema.bytes))]).toEqual([root.link]);
  });
});

type Bounds = { readonly min: number; readonly max: number };

const boundsSchema: Schema<Json, Bounds> = await encodeSchema(
  {
    $schema: DRAFT,
    type: "object",
    properties: { min: { type: "integer" }, max: { type: "integer" } },
    required: ["min", "max"],
    additionalProperties: false,
  },
  defaultValidator,
);

// Each bounds is the schema of the counts within it.
const counts: SchemaValidator<Json, Bounds> = {
  language: {
    encoding: json,
    link: boundsSchema.link,
    blobs: boundsSchema.blobs,
    data: (bounds) => bounds,
    document: (data) => boundsSchema.validate(data),
  },
  compile:
    async ({ min, max }) =>
    ({ count }) =>
      typeof count === "number" && min <= count && count <= max ? [] : [`#/count: not within ${min} and ${max}`],
};

describe("a language whose schemas are objects of a schema", () => {
  const dozen = encodeSchema({ min: 0, max: 12 }, counts);

  it("writes a schema as an object of that schema, which checks the objects written to it", async () => {
    const schema = await dozen;
    expect(json.decode(schema.bytes)).toEqual({ $schema: { $link: boundsSchema.link }, min: 0, max: 12 });
    expect(encodeObject(schema, { count: 12 }).data).toEqual({ count: 12 });
    expect(() => encodeObject(schema, { count: 13 })).toThrow(/does not fit/);
  });

  it("gives as a schema's blobs the schema, the schema it is written to and that one's root", async () => {
    const schema = await dozen;
    expect(schema.blobs).toEqual([schema.bytes, boundsSchema.bytes, root.bytes]);
  });

  it("refuses a schema whose data does not fit the schema it is written to", async () => {
    const text = `{"$schema":{"$link":"${boundsSchema.link}"},"min":0}`;
    await expect(decodeSchema(utf8(text), counts)).rejects.toThrow(/does not fit/);
  });

  it("refuses a schema written to the root of JSON Schema", async () => {
    await expect(decodeSchema(utf8(schemaText(`"document":{"$schema":"${DRAFT}"}`)), counts)).rejects.toThrow(
      `is written to ${boundsSchema.link}, not to ${root.link}`,
    );
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
    const pair = await compile({
      $schema: DRAFT,
      properties: { pair: { $ref: "https://example.com/child" } },
      $defs: { child },
    });
    expect(() => pair.validate({ pair: ["a"] })).not.toThrow();
    expect(() => pair.validate({ pair: [1] })).toThrow();
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
    await expect(
      compile({ $schema: DRAFT, anyOf: [{ type: "string" }, { $ref: "https://example.com/schema" }] }),
    ).rejects.toThrow();
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
    await expect(
      compile({ $schema: DRAFT, $ref: DRAFT, $defs: { own: { $id: DRAFT, type: "number" } } }),
    ).rejects.toThrow();
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
    expect(() => deny.validate({})).toThrow();
  });

  it("follows a $ref within the schema", async () => {
    const schema = await compile({
      $schema: DRAFT,
      properties: { names: { type: "array", items: { $ref: "#/$defs/name" } } },
      $defs: { name: { type: "string", minLength: 1 } },
    });
    expect(() => schema.validate({ names: ["a", "b"] })).not.toThrow();
    expect(() => schema.validate({ names: ["a", ""] })).toThrow();
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
    expect(() => tree.validate({ children: [{ children: [] }] })).not.toThrow();
    expect(() => tree.validate({ children: [{ name: "x" }] })).toThrow();
  });

  it("follows a $dynamicRef", async () => {
    const tree = await compile({
      $schema: DRAFT,
      $id: "https://example.com/tree",
      $dynamicAnchor: "node",
      type: "object",
      properties: { children: { type: "array", items: { $dynamicRef: "#node" } } },
    });
    expect(() => tree.validate({ children: [{ children: [] }] })).not.toThrow();
    expect(() => tree.validate({ children: [42] })).toThrow();
  });

  it("reads only the members a value has", async () => {
    const optional = await compile({ $schema: DRAFT, type: "object", properties: { constructor: { type: "string" } } });
    expect(() => optional.validate({})).not.toThrow();
    expect(() => optional.validate({ constructor: "x" })).not.toThrow();
    expect(() => optional.validate({ constructor: 1 })).toThrow();
    const required = await compile({ $schema: DRAFT, type: "object", required: ["constructor"] });
    expect(() => required.validate({})).toThrow();
  });

  it("asserts format", async () => {
    const date = await compile({ $schema: DRAFT, properties: { on: { type: "string", format: "date" } } });
    expect(() => date.validate({ on: "2026-10-19" })).not.toThrow();
    expect(() => date.validate({ on: "2026-13-45" })).toThrow();
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
    expect(() => contract.validate({ terms: { $link: terms } })).not.toThrow();
  });

  it("refuses a link that is not sha256 and lowercase hex", () => {
    for (const link of [terms.toUpperCase(), terms.slice(0, -1), terms.replace("sha256", "sha512")]) {
      expect(() => contract.validate({ terms: { $link: link } })).toThrow();
    }
  });

  it("refuses a link written as a bare string, or with a member besides $link", () => {
    expect(() => contract.validate({ terms })).toThrow();
    expect(() => contract.validate({ terms: { $link: terms, note: "x" } })).toThrow();
  });
});

const evenOnly: JsonSchemaValidator = {
  language: jsonSchema,
  async compile() {
    return ({ n }) => (typeof n === "number" && n % 2 !== 0 ? ["odd"] : []);
  },
};
const even = await encodeSchema({ $schema: "https://example.com/even" }, evenOnly);

describe("a validator other than the default", () => {
  it("decides what an object may hold, when encoding and when decoding", async () => {
    expect(encodeObject(even, { n: 2 }).data).toEqual({ n: 2 });
    expect(() => encodeObject(even, { n: 3 })).toThrow();
    const anything = await decodeSchema(even.bytes, lenient);
    const odd = encodeObject(anything, { n: 3 });
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
  const bytes = (await encodeSchema({ $schema: DRAFT, properties: { n: { type: "integer" } } }, defaultValidator))
    .bytes;
  const read = await decodeSchema(bytes, lenient);
  expect(read.link).toBe((await decodeSchema(bytes, defaultValidator)).link);
  expect(() => read.validate({ n: "not an integer" })).not.toThrow();
});
