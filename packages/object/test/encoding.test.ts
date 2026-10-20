import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { decodeObject, encodeObject, encodeSchema, linkOf } from "../src/index.ts";

const anything = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const objectText = (data: string) => `{"data":${data},"schema":"${anything.link}"}`;
const decodeText = (text: string) => decodeObject(utf8(text), anything);

describe("strict decoding", () => {
  it("accepts the canonical form", () => {
    expect(decodeText(objectText('{"a":[1,"x"],"b":null}')).data).toEqual({ a: [1, "x"], b: null });
  });

  it.each([
    ["whitespace between members", `{"data":1, "schema":"${anything.link}"}`],
    ["a trailing newline", `${objectText("1")}\n`],
    ["keys out of order", `{"schema":"${anything.link}","data":1}`],
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
