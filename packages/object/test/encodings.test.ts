import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  schemaOf,
  Semantics,
  type Encoding,
  type Link,
  type SchemaValidator,
} from "../src/index.ts";

// An encoding with nothing of JSON in it, to show that objects, schemas and
// semantics hold over any: data is lines of text, each ended by a newline,
// and an object is the schema's link on the first line with its data after.
type Lines = readonly string[];

// Kept, a byte order mark is part of the first line, so that bytes with one
// do not read as the same value as bytes without.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isLink = (line: string): line is Link<never> => /^sha256:[0-9a-f]{64}$/.test(line);

const lines: Encoding<Lines> = {
  encode(value) {
    if (value.some((line) => line.includes("\n"))) throw new Error("a line holds no newline");
    return new TextEncoder().encode(value.map((line) => `${line}\n`).join(""));
  },
  decode(bytes) {
    const text = utf8.decode(bytes);
    if (text !== "" && !text.endsWith("\n")) throw new Error("the last line is not ended");
    return text === "" ? [] : text.slice(0, -1).split("\n");
  },
  object: (data, schema) => [schema, ...data],
  fields([schema, ...data]) {
    if (schema === undefined || !isLink(schema)) throw new Error("an object names its schema by link");
    return { data, schema };
  },
  links: (value) => value.filter(isLink),
};

// A schema says how many lines the data has.
const lineCount: SchemaValidator<number, Lines> = {
  language: {
    encoding: lines,
    encode: (count) => lines.encode([String(count)]),
    decode(bytes) {
      const [count, ...rest] = lines.decode(bytes);
      if (count === undefined || rest.length > 0 || !/^(0|[1-9][0-9]*)$/.test(count)) throw new Error("not a count of lines");
      return Number(count);
    },
  },
  compile: async (count) => (data) => (data.length === count ? [] : [`${data.length} lines, not ${count}`]),
};

const pair = await encodeSchema(2, lineCount);
const word = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);

describe("an encoding other than JSON", () => {
  it("writes its objects as it writes any value, and reads them back", () => {
    const object = encodeObject(pair, ["hello", "world"]);
    expect(new TextDecoder().decode(object.bytes)).toBe(`${pair.link}\nhello\nworld\n`);
    expect(decodeObject(object.bytes, pair)).toEqual(object);
    expect(schemaOf(object.bytes, lines)).toBe(pair.link);
  });

  it("refuses an object whose data does not fit its schema", () => {
    expect(() => encodeObject(pair, ["hello"])).toThrow(/does not fit/);
  });

  it("is read by a semantics of its own, which refuses a JSON object", () => {
    const greetings: Semantics<string, string> = new Semantics([{ schema: pair, read: ([greeting, name]) => `${greeting}, ${name}` }], {
      schema: pair.link,
      write: (name) => ["hello", name],
    });
    expect(greetings.encode("world")).toBe("hello, world");
    const received: Uint8Array = encodeObject(word, "hello").bytes;
    expect(() => greetings.decode(received)).toThrow();
  });
});

test("a semantics refuses schemas of two encodings", () => {
  // @ts-expect-error: refused at compile time too
  expect(() => new Semantics([{ schema: pair, read: () => 1 }, { schema: word, read: () => 2 }])).toThrow(/more than one encoding/);
});
