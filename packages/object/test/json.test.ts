import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, encodeObject, encodeSchema, json, linkOf } from "../src/index.ts";

const anything = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const objectText = (data: string) => `{"data":${data},"schema":{"$link":"${anything.link}"}}`;
const decodeText = (text: string) => decodeObject(utf8(text), anything);

describe("strict decoding", () => {
  it("accepts the canonical form", () => {
    expect(decodeText(objectText('{"a":[1,"x"],"b":null}')).data).toEqual({ a: [1, "x"], b: null });
  });

  it.each([
    ["whitespace between members", `{"data":1, "schema":{"$link":"${anything.link}"}}`],
    ["a trailing newline", `${objectText("1")}\n`],
    ["keys out of order", `{"schema":{"$link":"${anything.link}"},"data":1}`],
    ["a repeated key", objectText('{"a":1,"a":1}')],
    ["a number with a needless fraction", objectText("1.0")],
    ["a number with a needless exponent", objectText("1e2")],
    ["negative zero", objectText("-0")],
    ["an integer a double cannot hold exactly", objectText("1152921504606846977")],
    ["a lone surrogate", objectText('"\\ud800"')],
    ["a needless escape", objectText('"\\u0041"')],
    ["an escaped solidus", objectText('"a\\/b"')],
    ["the schema link in uppercase hex", objectText("1").replace(anything.link.slice(7), anything.link.slice(7).toUpperCase())],
  ])("refuses %s", (_, text) => {
    expect(() => decodeText(text)).toThrow();
  });

  it("refuses invalid UTF-8", () => {
    const bytes = utf8(objectText('"~"'));
    bytes[bytes.indexOf(0x7e)] = 0xff;
    expect(() => decodeObject(bytes, anything)).toThrow();
  });

  it("refuses a byte order mark", () => {
    expect(() => decodeObject(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8(objectText("1"))), anything)).toThrow();
  });
});

describe("an object with a $link member", () => {
  const link = anything.link;

  it("reads back as a link when it holds a link and nothing else, wherever it is", () => {
    const data = { a: { $link: link }, b: [{ $link: link }] };
    expect(decodeText(objectText(JSON.stringify(data))).data).toEqual(data);
  });

  it.each([
    ["holds something other than a link", { $link: "hello" }],
    ["holds a link in uppercase hex", { $link: `sha256:${link.slice(7).toUpperCase()}` }],
    ["holds a number", { $link: 1 }],
    ["holds a link and another member", { $link: link, note: "x" }],
    ["holds a schema, as properties naming $link would", { $link: { type: "string" } }],
  ])("is refused in writing and in reading when it %s, at any depth", (_, malformed) => {
    for (const data of [malformed, { a: [malformed] }]) {
      expect(() => encodeObject(anything, data)).toThrow(/\$link/);
      expect(() => decodeText(objectText(JSON.stringify(data)))).toThrow(/\$link/);
    }
  });

  it("is refused in a schema too", async () => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", properties: { $link: { type: "string" } } };
    await expect(encodeSchema(schema, defaultValidator)).rejects.toThrow(/\$link/);
  });
});

test.each([
  ["0.1", 0.1, "0.1"],
  ["10^21", 1e21, "1e+21"],
  ["2^60", 2 ** 60, "1152921504606847000"],
])("%s is written as JCS writes it and reads back", (_, value, written) => {
  const object = encodeObject(anything, value);
  expect(new TextDecoder().decode(object.bytes)).toBe(objectText(written));
  expect(decodeObject(object.bytes, anything).data).toBe(value);
});

test("a string is written as UTF-8 and reads back", () => {
  const object = encodeObject(anything, "Estoc 簽名 ✍️");
  expect(new TextDecoder().decode(object.bytes)).toBe(objectText('"Estoc 簽名 ✍️"'));
  expect(decodeObject(object.bytes, anything).data).toBe("Estoc 簽名 ✍️");
});

test("a lone surrogate cannot be encoded", () => {
  expect(() => encodeObject(anything, "\ud800")).toThrow();
});

test("any bytes, JSON or not, are linked by their SHA-256, as a decoded blob is", () => {
  const bytes = utf8("not JSON");
  expect(linkOf(bytes)).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const object = encodeObject(anything, "hello");
  expect(linkOf(object.bytes)).toBe(object.link);
});

describe("the links in a JSON value", () => {
  const a = linkOf(utf8("a"));
  const b = linkOf(utf8("b"));

  it("are the strings that are links as a whole, at any depth and as member names", () => {
    const value = { list: [a, { nested: [b] }], [b]: "named by a link", count: 1, none: null };
    expect([...json.links(value)].sort()).toEqual([a, b, b].sort());
  });

  it("include the schema an object names", () => {
    const object = encodeObject(anything, [a]);
    expect([...json.links(json.decode(object.bytes))]).toEqual([a, anything.link]);
  });

  it("leave out a string that only holds a link, or that is not one exactly", () => {
    const value = [`see ${a}`, a.toUpperCase(), a.replace("sha256:", "sha512:"), a.slice(0, -1)];
    expect([...json.links(value)]).toEqual([]);
  });
});
