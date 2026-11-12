import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { itself, type Json, type JsonObject, json, linkOf } from "../src/index.ts";

// JSON has no mark for an object written to itself, so no language of schemas
// is over it, and these tests read and write its objects with the encoding
// alone, naming a schema by the link of some bytes.
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);
const anything = { link: linkOf(utf8("a schema")) };
const objectText = (value: string) => `{"$schema":{"$link":"${anything.link}"},"v":${value}}`;
const decodeText = (text: string) => json.fields(json.decode(utf8(text)));
const encodeData = (data: JsonObject) => json.encode(json.object(data, anything.link));

describe("strict decoding", () => {
  it("accepts the canonical form", () => {
    expect(decodeText(objectText('{"a":[1,"x"],"b":null}')).data).toEqual({ v: { a: [1, "x"], b: null } });
  });

  it.each([
    ["whitespace between members", `{"$schema":{"$link":"${anything.link}"}, "v":1}`],
    ["a trailing newline", `${objectText("1")}\n`],
    ["keys out of order", `{"v":1,"$schema":{"$link":"${anything.link}"}}`],
    ["a repeated key", objectText('{"a":1,"a":1}')],
    ["a number with a needless fraction", objectText("1.0")],
    ["a number with a needless exponent", objectText("1e2")],
    ["negative zero", objectText("-0")],
    ["an integer a double cannot hold exactly", objectText("1152921504606846977")],
    ["a lone surrogate", objectText('"\\ud800"')],
    ["a needless escape", objectText('"\\u0041"')],
    ["an escaped solidus", objectText('"a\\/b"')],
    [
      "the schema link in uppercase hex",
      objectText("1").replace(anything.link.slice(7), anything.link.slice(7).toUpperCase()),
    ],
  ])("refuses %s", (_, text) => {
    expect(() => decodeText(text)).toThrow();
  });

  it("refuses invalid UTF-8", () => {
    const bytes = utf8(objectText('"~"'));
    bytes[bytes.indexOf(0x7e)] = 0xff;
    expect(() => json.decode(bytes)).toThrow();
  });

  it("refuses a byte order mark", () => {
    expect(() => json.decode(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8(objectText("1"))))).toThrow();
  });
});

describe("an object with a $link member", () => {
  const link = anything.link;

  it("reads back as a link when it holds a link and nothing else, wherever it is", () => {
    const data = { a: { $link: link }, b: [{ $link: link }] };
    expect(decodeText(objectText(JSON.stringify(data))).data).toEqual({ v: data });
  });

  it.each([
    ["holds something other than a link", { $link: "hello" }],
    ["holds a link in uppercase hex", { $link: `sha256:${link.slice(7).toUpperCase()}` }],
    ["holds a number", { $link: 1 }],
    ["holds a link and another member", { $link: link, note: "x" }],
    ["holds a schema, as properties naming $link would", { $link: { type: "string" } }],
  ])("is refused in writing and in reading when it %s, at any depth", (_, malformed) => {
    for (const data of [malformed, { a: [malformed] }]) {
      expect(() => encodeData({ v: data as Json })).toThrow(/\$link/);
      expect(() => decodeText(objectText(JSON.stringify(data)))).toThrow(/\$link/);
    }
  });

  it("is refused in a value that is not an object too", () => {
    expect(() => json.decode(utf8('{"fields":[{"$link":"text"}]}'))).toThrow(/\$link/);
  });
});

test.each([
  ["0.1", 0.1, "0.1"],
  ["10^21", 1e21, "1e+21"],
  ["2^60", 2 ** 60, "1152921504606847000"],
])("%s is written as JCS writes it and reads back", (_, value, written) => {
  const bytes = encodeData({ v: value });
  expect(new TextDecoder().decode(bytes)).toBe(objectText(written));
  expect(json.fields(json.decode(bytes)).data.v).toBe(value);
});

test("a string is written as UTF-8 and reads back", () => {
  const bytes = encodeData({ v: "Estoc 簽名 ✍️" });
  expect(new TextDecoder().decode(bytes)).toBe(objectText('"Estoc 簽名 ✍️"'));
  expect(json.fields(json.decode(bytes)).data.v).toBe("Estoc 簽名 ✍️");
});

test("a lone surrogate cannot be encoded", () => {
  expect(() => encodeData({ v: "\ud800" })).toThrow();
});

test("any bytes, JSON or not, are linked by their SHA-256", () => {
  const bytes = utf8("not JSON");
  expect(linkOf(bytes)).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
});

describe("an object of JSON", () => {
  it("reads back as its data without its $schema, and the schema it names", () => {
    expect(decodeText(objectText("1"))).toEqual({ data: { v: 1 }, schema: anything.link });
  });

  it("is refused when its data has a $schema of its own", () => {
    expect(() => json.object({ $schema: { $link: anything.link } }, anything.link)).toThrow(/\$schema/);
    expect(() => json.object({ $schema: "note" }, anything.link)).toThrow(/\$schema/);
  });

  it("is not written to itself", () => {
    expect(() => json.object({ v: 1 }, itself)).toThrow(/written to itself/);
  });

  it.each([
    ["without a $schema", '{"v":1}'],
    ["whose $schema is null", '{"$schema":null,"v":1}'],
    ["whose $schema is not a link", '{"$schema":{"$link":"login"},"v":1}'],
    ["whose $schema is a link as a bare string", `{"$schema":"${anything.link}","v":1}`],
    ["whose $schema has a member besides $link", `{"$schema":{"$link":"${anything.link}","note":"x"},"v":1}`],
    ["whose $schema is a dialect, as a JSON Schema document's is", `{"$schema":"${DRAFT}","v":1}`],
    ["whose $schema is an object without $link", `{"$schema":{"$schema":"${DRAFT}"},"v":1}`],
    ["that is an array", `[1,{"$link":"${anything.link}"}]`],
    ["that is a string", `"${anything.link}"`],
  ])("is not read from a value %s", (_, text) => {
    expect(() => decodeText(text)).toThrow();
  });
});

describe("the links in a JSON value", () => {
  const a = linkOf(utf8("a"));
  const b = linkOf(utf8("b"));

  it("are the ones an object's $link objects hold, at any depth, its schema among them", () => {
    const bytes = encodeData({ list: [{ $link: a }, { nested: [{ $link: b }] }], again: { $link: b } });
    expect([...json.links(json.decode(bytes))].sort()).toEqual([anything.link, a, b, b].sort());
  });

  it.each([
    ["has no $schema", { list: [{ $link: a }] }],
    ["has a $schema that is null", { $schema: null, list: [{ $link: a }] }],
    ["names its dialect in $schema, as a JSON Schema document does", { $schema: DRAFT, list: [{ $link: a }] }],
    ["names its schema by a bare string", { $schema: a, list: [{ $link: a }] }],
    ["is an array", [{ $schema: { $link: a } }]],
  ])("are none in a value that %s, which is bytes", (_, value) => {
    expect([...json.links(value)]).toEqual([]);
  });

  it("leave out a string that is a link as a whole, as a member or as a member's name", () => {
    const value = json.object({ list: [a, { [a]: "named by a link", text: a }] }, anything.link);
    expect([...json.links(value)]).toEqual([anything.link]);
  });

  it("are refused at an object with a $link member that is not a link", () => {
    expect(() => [...json.links(json.object({ list: [{ $link: a, note: "x" }] }, anything.link))]).toThrow(/\$link/);
  });
});
