import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type SchemaValidator,
} from "../src/index.ts";
import { type FieldNames, fieldNames } from "./field-names.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const lenient: SchemaValidator<Json, FieldNames> = { language: fieldNames.language, compile: () => () => [] };

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, the document as the language writes it", () => {
    const schema = encodeSchema({ fields: ["audience", "nonce"] }, fieldNames);
    const read = decodeSchema(schema.bytes, fieldNames);
    expect(new TextDecoder().decode(read.bytes)).toBe('{"fields":["audience","nonce"]}');
    expect(read.link).toBe(schema.link);
  });

  it("reads a schema written out by hand", () => {
    const text = '{"fields":["audience","nonce"]}';
    expect(new TextDecoder().decode(decodeSchema(utf8(text), lenient).bytes)).toBe(text);
  });

  it.each([
    ["an array", "[]", /is a JSON object/],
    ["a document holding more than fields", '{"fields":[],"title":"Name"}', /not title/],
    ["a document with a $schema that is no link", '{"$schema":null,"fields":[]}', /not \$schema/],
  ])("refuses %s", (_, text, reason) => {
    expect(() => decodeSchema(utf8(text), lenient)).toThrow(reason);
  });

  it("refuses bytes that are not a schema of the language, whatever the validator", () => {
    expect(() => decodeSchema(utf8('{"fields":"audience"}'), lenient)).toThrow(/are names/);
    expect(() => decodeSchema(utf8('{"fields":["audience",1]}'), lenient)).toThrow(/are names/);
  });

  it("refuses an object, even one whose data is a document", () => {
    const anything = encodeSchema({}, fieldNames);
    const object = encodeObject(anything, { fields: [] });
    // @ts-expect-error: refused at compile time too
    expect(() => decodeSchema(object.bytes, fieldNames)).toThrow(
      `a schema is bytes and links to nothing, not to ${anything.link}`,
    );
  });
});

describe("a schema", () => {
  it("links to nothing, so that its closure is itself", () => {
    const schema = encodeSchema({ fields: ["to"] }, fieldNames);
    expect([...json.links(json.decode(schema.bytes))]).toEqual([]);
  });
});

const evenOnly: SchemaValidator<Json, FieldNames> = {
  language: fieldNames.language,
  compile:
    () =>
    ({ n }) =>
      typeof n === "number" && n % 2 !== 0 ? ["odd"] : [],
};
const even = encodeSchema({ fields: ["n"] }, evenOnly);

describe("a validator", () => {
  it("decides what an object may hold, when encoding and when decoding", () => {
    expect(encodeObject(even, { n: 2 }).data).toEqual({ n: 2 });
    expect(() => encodeObject(even, { n: 3 })).toThrow();
    const anything = decodeSchema(even.bytes, lenient);
    const odd = encodeObject(anything, { n: 3 });
    expect(() => decodeObject(odd.bytes, even)).toThrow();
  });

  it("refusing to compile a schema leaves no schema", () => {
    const refusing: SchemaValidator<Json, FieldNames> = {
      language: fieldNames.language,
      compile() {
        throw new Error("unsupported");
      },
    };
    expect(() => encodeSchema({ fields: ["n"] }, refusing)).toThrow("unsupported");
    expect(() => decodeSchema(even.bytes, refusing)).toThrow("unsupported");
  });
});

test("the same bytes read by two validators give one link", () => {
  const { bytes } = encodeSchema({ fields: ["n"] }, fieldNames);
  const read = decodeSchema(bytes, lenient);
  expect(read.link).toBe(decodeSchema(bytes, fieldNames).link);
  expect(() => read.validate({ m: 1 })).not.toThrow();
});
