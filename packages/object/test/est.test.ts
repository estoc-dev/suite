import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  decodeObject,
  type Est,
  EstLink,
  encodeObject,
  encodeSchema,
  est,
  itself,
  json,
  type Link,
  linkOf,
  schemaOf,
} from "../src/index.ts";
import { type Check, Schema } from "../src/schema.ts";
import { fieldNames } from "./field-names.ts";

// No schema language is over est, so these tests make their schemas by hand:
// an object written to itself, with a check of the test's own.
function schemaTitled(title: string, check: Check<Est> = () => []): Schema<Est> {
  const bytes = est.encode(est.object({ title }, itself));
  return new Schema(est, { bytes, link: linkOf(bytes) }, check);
}

const anything = schemaTitled("Anything");
const a = linkOf(new TextEncoder().encode("a"));
const b = linkOf(new TextEncoder().encode("b"));

// The bytes of the tests are written out by hand, in hex, so that they do not
// turn on the encoder they test.
const objectHead = "da6573743f82";
const itselfHex = "6473656c66";
const linkHex = (link: Link<unknown>) => `d9486c5820${link.slice("sha256:".length)}`;
const objectHex = (fields: string, schema = linkHex(anything.link)) => `${objectHead}${schema}${fields}`;
const holding = (value: string) => objectHex(`a16176${value}`);
const decodeHex = (hex: string) => decodeObject(hexToBytes(hex), anything);

describe("an object of est", () => {
  it("is the tag of the format, around its schema and the map of its fields", () => {
    const object = encodeObject(anything, { text: "hello" });
    expect(bytesToHex(object.bytes)).toBe(
      `da6573743f82d9486c5820${anything.link.slice("sha256:".length)}a164746578746568656c6c6f`,
    );
    expect(object.bytes).toHaveLength(55);
    expect(object.link).toBe(`sha256:${createHash("sha256").update(object.bytes).digest("hex")}`);
  });

  it.each<[string, Est, string]>([
    ["zero", 0, "00"],
    ["23", 23, "17"],
    ["24", 24, "1818"],
    ["255", 255, "18ff"],
    ["256", 256, "190100"],
    ["65535", 65535, "19ffff"],
    ["65536", 65536, "1a00010000"],
    ["2^32", 2 ** 32, "1b0000000100000000"],
    ["2^53 - 1", 2 ** 53 - 1, "1b001fffffffffffff"],
    ["-1", -1, "20"],
    ["-24", -24, "37"],
    ["-25", -25, "3818"],
    ["-(2^53 - 1)", -(2 ** 53 - 1), "3b001ffffffffffffe"],
    ["bytes", Uint8Array.of(1, 2), "420102"],
    ["no bytes", new Uint8Array(), "40"],
    ["a string", "hello", "6568656c6c6f"],
    ["a string beyond ASCII", "簽", "63e7b0bd"],
    ["an empty string", "", "60"],
    ["true", true, "f5"],
    ["false", false, "f4"],
    ["an array", [1, "a", [true]], "8301616181f5"],
    ["a map, its keys in the order of their bytes", { b: 1, aa: 3, a: 2 }, "a361610261620162616103"],
    ["a link", new EstLink(a), linkHex(a)],
    ["a hash that is bytes", hexToBytes(a.slice("sha256:".length)), `5820${a.slice("sha256:".length)}`],
  ])("writes %s one way, and reads it back", (_, value, hex) => {
    expect(bytesToHex(encodeObject(anything, { v: value }).bytes)).toBe(holding(hex));
    expect(decodeHex(holding(hex)).data).toEqual({ v: value });
  });

  it("keeps a member named __proto__ as a member", () => {
    const data = JSON.parse('{"__proto__":{"__proto__":1}}');
    const read = decodeObject(encodeObject(anything, data).bytes, anything).data;
    expect(Object.hasOwn(read, "__proto__")).toBe(true);
    expect(Object.entries(read)).toEqual([["__proto__", JSON.parse('{"__proto__":1}')]]);
  });

  it("is refused when its data does not fit its schema", () => {
    const titled = schemaTitled("Titled", (data) => (typeof data.title === "string" ? [] : ["#/title: not a string"]));
    expect(encodeObject(titled, { title: "hello" }).data).toEqual({ title: "hello" });
    expect(() => encodeObject(titled, { title: 1 })).toThrow(/does not fit/);
  });

  it("is refused when read with a schema other than its own", () => {
    const other = schemaTitled("Other");
    expect(() => decodeObject(encodeObject(anything, { text: "hello" }).bytes, other)).toThrow(/is written to/);
  });

  it("is not a JSON object, nor a JSON object one of est", () => {
    const inJson = encodeObject(encodeSchema({}, fieldNames), { text: "hello" });
    expect(() => est.decode(inJson.bytes)).toThrow();
    expect(() => json.decode(encodeObject(anything, { text: "hello" }).bytes)).toThrow();
  });
});

describe("strict decoding", () => {
  const sha512Tag = "d94850";

  it.each([
    ["an integer in a longer head", holding("1801")],
    ["a length in a longer head", holding("780161")],
    ["the tag of the format in a longer head", `db000000006573743f82${linkHex(anything.link)}a0`],
    ["the tag of a link in a longer head", holding(`da0000486c5820${a.slice("sha256:".length)}`)],
    ["keys out of order", objectHex("a2616201616101")],
    ["a longer key before a shorter one", objectHex("a262616101616201")],
    ["a repeated key", objectHex("a2616101616101")],
    ["an array of indefinite length", holding("9f01ff")],
    ["a map of indefinite length", holding("bf616101ff")],
    ["a string of indefinite length", holding("7f6161ff")],
    ["bytes of indefinite length", holding("5f4101ff")],
    ["a float", holding("f93e00")],
    ["an integer written as a float", holding("f93c00")],
    ["negative zero", holding("f98000")],
    ["NaN", holding("f97e00")],
    ["Infinity", holding("f97c00")],
    ["null", holding("f6")],
    ["undefined", holding("f7")],
    ["a simple value", holding("f0")],
    ["2^53", holding("1b0020000000000000")],
    ["-(2^53)", holding("3b001fffffffffffff")],
    ["a bignum", holding("c249010000000000000000")],
    ["a tag other than that of a link", holding("d82a4100")],
    ["a hash under the tag of SHA-512", holding(`${sha512Tag}5840${"00".repeat(64)}`)],
    ["a link of 31 bytes", holding(`d9486c581f${"00".repeat(31)}`)],
    ["a link of 33 bytes", holding(`d9486c5821${"00".repeat(33)}`)],
    ["a link around a string", holding("d9486c6161")],
    ["an object inside its data", holding(objectHex("a0"))],
    ["a key that is not a string", objectHex("a10101")],
    ["invalid UTF-8 in a string", holding("61ff")],
    ["invalid UTF-8 in a key", objectHex("a161ff01")],
    ["a surrogate written in UTF-8", holding("63eda080")],
    ["a byte after the object", `${objectHex("a0")}00`],
    ["a second object after the first", objectHex("a0").repeat(2)],
    ["no bytes", ""],
    ["a map under no tag", "a0"],
    ["a schema and data under no tag", `82${linkHex(anything.link)}a0`],
    ["a link under no tag of the format", linkHex(anything.link)],
    ["a schema without data", `da6573743f81${linkHex(anything.link)}`],
    ["a third item after its data", `da6573743f83${linkHex(anything.link)}a0a0`],
    ["data that is not a map", `${objectHead}${linkHex(anything.link)}80`],
    ["a schema named by a string other than self", objectHex("a0", "64726f6f74")],
    ["a schema named by Self", objectHex("a0", "6453656c66")],
    ["a schema named by a hash that is bytes", objectHex("a0", `5820${a.slice("sha256:".length)}`)],
  ])("refuses %s", (_, hex) => {
    expect(() => est.decode(hexToBytes(hex))).toThrow();
  });

  it("reads the same bytes written the one way", () => {
    expect(decodeHex(holding("01")).data).toEqual({ v: 1 });
    expect(decodeHex(objectHex("a2616101616201")).data).toEqual({ a: 1, b: 1 });
    expect(decodeHex(objectHex("a0")).data).toEqual({});
  });
});

describe("encoding", () => {
  it.each<[string, unknown]>([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["2^53", 2 ** 53],
    ["a bigint", 10n],
    ["null", null],
    ["undefined", undefined],
    ["a lone surrogate", "\ud800"],
    ["a key with a lone surrogate", { "\ud800": 1 }],
    ["a hole in an array", new Array(2)],
    ["a Date", new Date(0)],
    ["a Map", new Map([["a", 1]])],
    ["an object inside data", est.object({}, anything.link)],
  ])("refuses %s", (_, value) => {
    expect(() => encodeObject(anything, { v: value as Est })).toThrow();
    expect(() => encodeObject(anything, { v: [{ nested: value as Est }] })).toThrow();
  });

  it("refuses a value that is not an object as a blob", () => {
    expect(() => est.encode({ text: "hello" })).toThrow(/is an object/);
    expect(() => est.encode(new EstLink(a))).toThrow(/is an object/);
  });

  it("refuses a link that is not one", () => {
    expect(() => new EstLink("sha256:ABC" as Link<never>)).toThrow();
    expect(() => est.encode(est.object({}, "note" as Link<never>))).toThrow();
  });
});

describe("an object written to itself", () => {
  it("names its schema by the string self, in place of a link", () => {
    expect(bytesToHex(anything.bytes)).toBe(`${objectHead}${itselfHex}a1657469746c6568416e797468696e67`);
    expect(est.fields(est.decode(anything.bytes)).schema).toBe(itself);
  });

  it("reads back with its own link as its schema", () => {
    expect(schemaOf(anything.bytes, est)).toBe(anything.link);
    const bytes: Uint8Array = anything.bytes;
    const read = decodeObject(bytes, anything);
    expect(read.schema.link).toBe(read.link);
    expect(read.data).toEqual({ title: "Anything" });
  });

  it("is refused as an object of another schema", () => {
    const bytes = est.encode(est.object({ text: "hello" }, itself));
    expect(schemaOf(bytes, est)).toBe(linkOf(bytes));
    expect(() => decodeObject(bytes, anything)).toThrow(/is written to/);
  });

  it("does not link to itself", () => {
    expect([...est.links(est.decode(anything.bytes))]).toEqual([]);
    const linking = est.encode(est.object({ to: new EstLink(a) }, itself));
    expect([...est.links(est.decode(linking))]).toEqual([a]);
  });

  it("cannot be written in JSON", () => {
    expect(() => json.object({ text: "hello" }, itself)).toThrow(/written to itself/);
  });
});

describe("the links in an object of est", () => {
  it("are the ones under the tag of a link, at any depth, its schema among them", () => {
    const object = encodeObject(anything, {
      list: [new EstLink(a), { nested: [new EstLink(b)] }],
      again: new EstLink(b),
    });
    expect([...est.links(est.decode(object.bytes))].sort()).toEqual([anything.link, a, b, b].sort());
  });

  it("leave out a hash that is bytes, and a string that reads as a link, as a member or as a key", () => {
    const value = est.object({ hash: hexToBytes(a.slice("sha256:".length)), text: a, map: { [a]: 1 } }, anything.link);
    expect([...est.links(value)]).toEqual([anything.link]);
  });

  it("are none in a value that is not an object", () => {
    expect([...est.links({ list: [new EstLink(a)] })]).toEqual([]);
    expect([...est.links(new EstLink(a))]).toEqual([]);
  });
});
