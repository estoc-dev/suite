import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Schema,
  type SchemaValidator,
  schemaOf,
} from "../src/index.ts";
import { type FieldNames, fieldNames, fieldNamesRoot } from "./field-names.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const lenient: SchemaValidator<Json, FieldNames> = { language: fieldNames.language, compile: () => () => [] };

const root = fieldNamesRoot;
const schemaText = (...members: string[]) => `{${[`"$schema":{"$link":"${root.link}"}`, ...members].join(",")}}`;

describe("the root of a language", () => {
  it("describes itself, and stands for the language", () => {
    expect(new TextDecoder().decode(root.bytes)).toBe('{"$schema":null,"language":"Field names"}');
    expect(schemaOf(root.bytes, json)).toBe(root.link);
  });

  it("is not a schema", () => {
    // @ts-expect-error: refused at compile time too
    expect(() => decodeSchema(root.bytes, lenient)).toThrow(/not to itself/);
  });
});

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, an object of the root holding the document", () => {
    const schema = encodeSchema({ fields: ["audience", "nonce"] }, fieldNames);
    const read = decodeSchema(schema.bytes, fieldNames);
    expect(json.decode(read.bytes)).toEqual({ $schema: { $link: root.link }, fields: ["audience", "nonce"] });
    expect(read.link).toBe(schema.link);
  });

  it("reads a schema written out by hand", () => {
    const text = schemaText('"fields":["audience","nonce"]');
    expect(new TextDecoder().decode(decodeSchema(utf8(text), lenient).bytes)).toBe(text);
  });

  it.each([
    ["an array", "[]", /names its schema/],
    [
      "JSON whose $schema is a string, which is bytes",
      '{"$schema":"https://example.com/schema","fields":[]}',
      /names its schema/,
    ],
    ["an object of the root holding more than fields", schemaText('"fields":[]', '"title":"Name"'), /not title/],
  ])("refuses %s", (_, text, reason) => {
    expect(() => decodeSchema(utf8(text), lenient)).toThrow(reason);
  });

  it("refuses data that is not a schema of the language, whatever the validator", () => {
    expect(() => decodeSchema(utf8(schemaText('"fields":"audience"')), lenient)).toThrow(/are names/);
    expect(() => decodeSchema(utf8(schemaText('"fields":["audience",1]')), lenient)).toThrow(/are names/);
  });

  it("refuses an object of another schema, even one holding a document", () => {
    const anything = encodeSchema({}, fieldNames);
    const object = encodeObject(anything, { fields: [] });
    // @ts-expect-error: refused at compile time too
    expect(() => decodeSchema(object.bytes, fieldNames)).toThrow(`is written to ${root.link}, not to ${anything.link}`);
  });

  it("refuses a schema that holds a link, which would put another blob in the schema's closure", () => {
    const note = encodeSchema({ fields: ["text"] }, fieldNames);
    const text = schemaText(`"fields":[{"$link":"${note.link}"}]`);
    expect(() => decodeSchema(utf8(text), lenient)).toThrow(
      `a schema links only to what it is written to, not to ${note.link}`,
    );
  });
});

describe("the blobs of a schema", () => {
  it("are its closure, the schema and the root of its language", () => {
    const schema = encodeSchema({ fields: ["to"] }, fieldNames);
    expect(schema.blobs).toEqual([schema.bytes, root.bytes]);
    expect([...json.links(json.decode(schema.bytes))]).toEqual([root.link]);
  });
});

type Bounds = { readonly min: number; readonly max: number };

const boundsSchema: Schema<Json, Bounds> = encodeSchema({ fields: ["min", "max"] }, fieldNames);

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
    ({ min, max }) =>
    ({ count }) =>
      typeof count === "number" && min <= count && count <= max ? [] : [`#/count: not within ${min} and ${max}`],
};

describe("a language whose schemas are objects of a schema", () => {
  const dozen = encodeSchema({ min: 0, max: 12 }, counts);

  it("writes a schema as an object of that schema, which checks the objects written to it", () => {
    expect(json.decode(dozen.bytes)).toEqual({ $schema: { $link: boundsSchema.link }, min: 0, max: 12 });
    expect(encodeObject(dozen, { count: 12 }).data).toEqual({ count: 12 });
    expect(() => encodeObject(dozen, { count: 13 })).toThrow(/does not fit/);
  });

  it("gives as a schema's blobs the schema, the schema it is written to and that one's root", () => {
    expect(dozen.blobs).toEqual([dozen.bytes, boundsSchema.bytes, root.bytes]);
  });

  it("refuses a schema whose data does not fit the schema it is written to", () => {
    const text = `{"$schema":{"$link":"${boundsSchema.link}"},"min":0}`;
    expect(() => decodeSchema(utf8(text), counts)).toThrow(/does not fit/);
  });

  it("refuses a schema written to the root that the bounds schema is written to", () => {
    expect(() => decodeSchema(utf8(schemaText('"fields":["min","max"]')), counts)).toThrow(
      `is written to ${boundsSchema.link}, not to ${root.link}`,
    );
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
