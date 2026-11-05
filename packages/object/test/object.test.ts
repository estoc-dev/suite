import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  type JsonObject,
  json,
  readObject,
  schemaOf,
  selfDescribingObject,
} from "../src/index.ts";

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
  ["without a $schema", '{"v":1}'],
  ["whose $schema is not a link", '{"$schema":{"$link":"login"},"v":1}'],
  ["whose $schema is a link as a bare string", `{"$schema":"${anything.link}","v":1}`],
  ["whose $schema has a member besides $link", `{"$schema":{"$link":"${anything.link}","note":"x"},"v":1}`],
  ["whose $schema is a dialect, as a JSON Schema document's is", `{"$schema":"${DRAFT}","v":1}`],
  ["whose $schema is a document", `{"$schema":{"$schema":"${DRAFT}"},"v":1}`],
  ["that is an array", `[1,{"$link":"${anything.link}"}]`],
  ["that is a string", `"${anything.link}"`],
];

describe("an object", () => {
  it.each<[string, JsonObject]>([
    ["fields", greeting],
    [
      "fields of every kind",
      { array: [1, "two", { three: null }], string: "hello", link: { $link: login.link }, null: null },
    ],
    ["no fields", {}],
    ["a $schema deeper in its data, which is data like any other", { inner: { $schema: { $link: login.link } } }],
  ])("holding %s reads back with the same link", (_, data) => {
    const object = encodeObject(anything, data);
    const read = decodeObject(object.bytes, anything);
    expect(read.data).toEqual(data);
    expect(read.link).toBe(object.link);
    expect(read.schema).toBe(anything);
  });

  it("reads back as its data without its $schema, which a closed schema need not name", () => {
    expect(decodeObject(encodeObject(login, greeting).bytes, login).data).toEqual(greeting);
  });

  it("is refused when its data has a $schema of its own", () => {
    expect(() => encodeObject(anything, { $schema: { $link: login.link } })).toThrow(/\$schema/);
    expect(() => encodeObject(anything, { $schema: "note" })).toThrow(/\$schema/);
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

describe("an object read by its link", () => {
  const object = encodeObject(login, greeting);

  it("is the object whose blob the reader gives for the link", async () => {
    expect(await readObject(new Map([[object.link, object.bytes]]), object.link, login)).toEqual(object);
  });

  it("is refused when the reader gives no blob for the link", async () => {
    await expect(readObject(new Map(), object.link, login)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when the reader gives another blob for the link", async () => {
    const other = encodeObject(login, { ...greeting, nonce: "9a2e" });
    await expect(readObject(new Map([[object.link, other.bytes]]), object.link, login)).rejects.toThrow(
      /is another blob/,
    );
  });
});

describe("the schema an object names", () => {
  it("is read without the schema, whether or not the data fits it", () => {
    expect(schemaOf(encodeObject(login, greeting).bytes, json)).toBe(login.link);
    expect(schemaOf(utf8(`{"$schema":{"$link":"${login.link}"},"v":1}`), json)).toBe(login.link);
  });

  it("is the object's own link for one that describes itself", () => {
    const itself = selfDescribingObject(json, { language: "Example" });
    expect(new TextDecoder().decode(itself.bytes)).toBe('{"$schema":null,"language":"Example"}');
    expect(schemaOf(itself.bytes, json)).toBe(itself.link);
  });

  it.each(malformed)("is not read from an object %s", (_, text) => {
    expect(() => schemaOf(utf8(text), json)).toThrow();
  });
});

test("a schema is an object of its root, and not of any schema", () => {
  expect(schemaOf(login.bytes, json)).toBe(login.root.link);
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(login.bytes, anything)).toThrow();
});

test("an object that describes itself is not an object of any schema", () => {
  const itself = selfDescribingObject(json, { v: 1 });
  // @ts-expect-error: refused at compile time too
  expect(() => decodeObject(itself.bytes, anything)).toThrow(/not to/);
});

test("an object read with a schema decoded from the same bytes keeps its link", async () => {
  const object = encodeObject(login, greeting);
  const schema = await decodeSchema(login.bytes, defaultValidator);
  expect(decodeObject(object.bytes, schema).link).toBe(object.link);
});
