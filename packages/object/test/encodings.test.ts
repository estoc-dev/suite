import { describe, expect, it } from "vitest";
import {
  decodeObject,
  decodeSchema,
  type Encoding,
  encodeObject,
  encodeSchema,
  itself,
  type Link,
  rootSchemaOf,
  type SchemaValidator,
  schemaOf,
} from "../src/index.ts";
import { fieldNames } from "./field-names.ts";

// An encoding with nothing of est in it, to show that objects and schemas
// hold over any: a value is fields of text, one to a line, written
// `name=text` in the order of their names. An object names its schema in the
// field `schema`, by link or as `self` when it is written to itself, and a
// link is written as it is.
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
    return { ...data, schema: schema === itself ? "self" : schema };
  },
  fields(value) {
    if (typeof value === "string") throw new Error("an object is fields");
    const { schema, ...data } = value;
    if (schema === "self") return { data, schema: itself };
    if (!isLink(schema)) throw new Error("an object names its schema by link, or as self");
    return { data, schema };
  },
  links(value) {
    if (typeof value === "string" || !(isLink(value.schema) || value.schema === "self")) return [];
    return Object.values(value).filter(isLink);
  },
};

// A document says how many fields the data has. A schema has one, its count.
const fieldCount: SchemaValidator<Text, string> = {
  language: {
    encoding: lines,
    root: "1",
    data: (count) => ({ count }),
    document({ count }) {
      if (typeof count !== "string" || !/^(0|[1-9][0-9]*)$/.test(count)) {
        throw new Error("a schema holds a count of fields");
      }
      return count;
    },
  },
  compile: (count) => (data) => {
    const fields = Object.keys(data).length;
    return fields === Number(count) ? [] : [`${fields} fields, not ${count}`];
  },
};

const pair = encodeSchema("2", fieldCount);
const note = encodeSchema({ fields: ["text"] }, fieldNames);

describe("an encoding other than est", () => {
  it("writes its objects as it writes any value, and reads them back", () => {
    const object = encodeObject(pair, { greeting: "hello", name: "world" });
    expect(new TextDecoder().decode(object.bytes)).toBe(`greeting=hello\nname=world\nschema=${pair.link}\n`);
    expect(decodeObject(object.bytes, pair)).toEqual(object);
    expect(schemaOf(object.bytes, lines)).toBe(pair.link);
  });

  it("writes its schemas as objects of its root schema, which is written to itself", () => {
    const root = rootSchemaOf(fieldCount);
    expect(new TextDecoder().decode(pair.bytes)).toBe(`count=2\nschema=${root.link}\n`);
    expect(new TextDecoder().decode(root.bytes)).toBe("count=1\nschema=self\n");
    expect(schemaOf(root.bytes, lines)).toBe(root.link);
    expect(pair.blobs).toEqual([pair.bytes, root.bytes]);
  });

  it("refuses a schema that does not fit its root schema", () => {
    const bytes = lines.encode(lines.object({ count: "2", title: "Pair" }, rootSchemaOf(fieldCount).link));
    expect(() => decodeSchema(bytes, fieldCount)).toThrow(/2 fields, not 1/);
  });

  it("refuses an object whose data does not fit its schema", () => {
    expect(() => encodeObject(pair, { greeting: "hello" })).toThrow(/does not fit/);
  });

  it("refuses an object of est read with one of its schemas", () => {
    const received: Uint8Array = encodeObject(note, { text: "hello" }).bytes;
    expect(() => decodeObject(received, pair)).toThrow();
  });
});
