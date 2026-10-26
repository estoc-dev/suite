import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  type Encoding,
  encodeObject,
  encodeSchema,
  type Link,
  type SchemaValidator,
  schemaOf,
} from "../src/index.ts";

// An encoding with nothing of JSON in it, to show that objects and schemas
// hold over any: a value is fields of text, one to a line, written
// `name=text` in the order of their names, and an object names its schema in
// the field `schema`.
type Text = string | { readonly [name: string]: Text };

// Kept, a byte order mark is part of the first name, so that bytes with one
// do not read as the same value as bytes without.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isLink = (text: Text | undefined): text is Link<never> =>
  typeof text === "string" && /^sha256:[0-9a-f]{64}$/.test(text);

const lines: Encoding<Text> = {
  encode(value) {
    if (typeof value === "string") throw new Error("a value is fields");
    const written = Object.keys(value)
      .sort()
      .map((name) => {
        const text = value[name];
        if (/[=\n]/.test(name)) throw new Error("a name holds no = and no newline");
        if (typeof text !== "string" || text.includes("\n")) throw new Error("a field holds a line of text");
        return `${name}=${text}\n`;
      });
    return new TextEncoder().encode(written.join(""));
  },
  decode(bytes) {
    const text = utf8.decode(bytes);
    if (text !== "" && !text.endsWith("\n")) throw new Error("the last line is not ended");
    const fields = text
      .split("\n")
      .slice(0, -1)
      .map((line) => {
        const at = line.indexOf("=");
        if (at < 0) throw new Error("a line is name=text");
        return [line.slice(0, at), line.slice(at + 1)];
      });
    const value = Object.fromEntries(fields);
    if (utf8.decode(lines.encode(value)) !== text) throw new Error("the fields are out of order or repeated");
    return value;
  },
  object(data, schema) {
    if (Object.hasOwn(data, "schema")) throw new Error("the data has no field schema");
    return { ...data, schema };
  },
  fields(value) {
    if (typeof value === "string") throw new Error("an object is fields");
    const { schema, ...data } = value;
    if (!isLink(schema)) throw new Error("an object names its schema by link");
    return { data, schema };
  },
  links: (value) => (typeof value === "string" ? [] : Object.values(value).filter(isLink)),
};

// A schema says how many fields the data has.
const fieldCount: SchemaValidator<number, Text> = {
  language: {
    encoding: lines,
    encode: (count) => lines.encode({ count: String(count) }),
    decode(bytes) {
      const value = lines.decode(bytes);
      const count = typeof value === "string" ? undefined : value.count;
      if (typeof count !== "string" || Object.keys(value).length !== 1 || !/^(0|[1-9][0-9]*)$/.test(count)) {
        throw new Error("not a count of fields");
      }
      return Number(count);
    },
  },
  compile: async (count) => (data) => {
    const fields = Object.keys(data).length;
    return fields === count ? [] : [`${fields} fields, not ${count}`];
  },
};

const pair = await encodeSchema(2, fieldCount);
const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);

describe("an encoding other than JSON", () => {
  it("writes its objects as it writes any value, and reads them back", () => {
    const object = encodeObject(pair, { greeting: "hello", name: "world" });
    expect(new TextDecoder().decode(object.bytes)).toBe(`greeting=hello\nname=world\nschema=${pair.link}\n`);
    expect(decodeObject(object.bytes, pair)).toEqual(object);
    expect(schemaOf(object.bytes, lines)).toBe(pair.link);
  });

  it("refuses an object whose data does not fit its schema", () => {
    expect(() => encodeObject(pair, { greeting: "hello" })).toThrow(/does not fit/);
  });

  it("refuses a JSON object read with one of its schemas", () => {
    const received: Uint8Array = encodeObject(note, { text: "hello" }).bytes;
    expect(() => decodeObject(received, pair)).toThrow();
  });
});
