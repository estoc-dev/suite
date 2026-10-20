import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, decodeSchema, encodeObject, encodeSchema, schemaOf, type Json } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);

const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const login = await encodeSchema(
  {
    $schema: DRAFT,
    type: "object",
    properties: { audience: { type: "string" }, nonce: { type: "string" } },
    required: ["audience", "nonce"],
    additionalProperties: false,
  },
  defaultValidator,
);
const greeting = { audience: "https://app.estoc.dev", nonce: "6f1c" };
const malformed: [string, string][] = [
  ["without data", `{"schema":"${anything.link}"}`],
  ["without a schema", '{"data":1}'],
  ["with a field besides data and schema", `{"data":1,"note":"x","schema":"${anything.link}"}`],
  ["whose schema is not a link", '{"data":1,"schema":"login"}'],
  ["whose schema is the schema itself", `{"data":1,"schema":{"$schema":"${DRAFT}"}}`],
  ["that is an array", `[1,"${anything.link}"]`],
];

describe("an object", () => {
  it.each<[string, Json]>([
    ["a JSON object", greeting],
    ["an array", [1, "two", { three: null }]],
    ["a string", "hello"],
    ["a link", login.link],
    ["null", null],
  ])("holding %s reads back with the same link", (_, data) => {
    const object = encodeObject(anything, data);
    const read = decodeObject(object.bytes, anything);
    expect(read.data).toEqual(data);
    expect(read.link).toBe(object.link);
    expect(read.schema).toBe(anything);
  });

  it("is linked by the SHA-256 of its bytes", () => {
    const object = encodeObject(login, greeting);
    expect(object.link).toBe(`sha256:${createHash("sha256").update(object.bytes).digest("hex")}`);
  });

  it("under another schema is another object", () => {
    expect(encodeObject(anything, greeting).link).not.toBe(encodeObject(login, greeting).link);
  });

  it("is refused when its data does not fit its schema", () => {
    expect(() => encodeObject(login, { audience: "https://app.estoc.dev" })).toThrow();
    const bytes = encodeObject(anything, { audience: "https://app.estoc.dev" }).bytes;
    expect(() => decodeObject(bytes, login)).toThrow();
  });

  it("is refused when read with a schema other than its own, even one its data fits", () => {
    expect(() => decodeObject(encodeObject(login, greeting).bytes, anything)).toThrow();
  });

  it.each(malformed)("is refused %s", (_, text) => {
    expect(() => decodeObject(utf8(text), anything)).toThrow();
  });
});

describe("the schema an object names", () => {
  it("is read without the schema, whether or not the data fits it", () => {
    expect(schemaOf(encodeObject(login, greeting).bytes)).toBe(login.link);
    expect(schemaOf(utf8(`{"data":1,"schema":"${login.link}"}`))).toBe(login.link);
  });

  it.each(malformed)("is not read from an object %s", (_, text) => {
    expect(() => schemaOf(utf8(text))).toThrow();
  });
});

test("a schema's bytes are not an object", () => {
  expect(() => decodeObject(login.bytes, anything)).toThrow();
});

test("an object read with a schema decoded from the same bytes keeps its link", async () => {
  const object = encodeObject(login, greeting);
  const schema = await decodeSchema(login.bytes, defaultValidator);
  expect(decodeObject(object.bytes, schema).link).toBe(object.link);
});
