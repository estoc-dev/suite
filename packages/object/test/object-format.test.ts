import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  itself,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  rootSchemaOf,
  schemaOf,
  type Value,
} from "../src/index.ts";
import { fieldNames } from "./field-names.ts";

const anything = encodeSchema({ fields: "any" }, fieldNames);
const a = linkOf(new TextEncoder().encode("a"));
const b = linkOf(new TextEncoder().encode("b"));

// The bytes of the tests are written out by hand, in hex, so that they do not
// turn on the encoder they test.
const objectHead = "da656f662182";
const itselfHex = "6473656c66";
const linkHex = (link: Link<unknown>) => `d9486c5820${link.slice("sha256:".length)}`;
const objectHex = (fields: string, schema = linkHex(anything.link)) => `${objectHead}${schema}${fields}`;
const objectHexHolding = (value: string) => objectHex(`a16176${value}`);
const decodeHex = (hex: string) => decodeObject(hexToBytes(hex), anything);

describe("an object", () => {
  it("is the tag of the format, around its schema and the map of its fields", () => {
    const object = encodeObject(anything, { text: "hello" });
    expect(bytesToHex(object.bytes)).toBe(
      `da656f662182d9486c5820${anything.link.slice("sha256:".length)}a164746578746568656c6c6f`,
    );
    expect(object.bytes).toHaveLength(55);
    expect(object.link).toBe(`sha256:${createHash("sha256").update(object.bytes).digest("hex")}`);
  });

  it.each<[string, Value, string]>([
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
    ["a link", new LinkValue(a), linkHex(a)],
    ["a hash that is bytes", hexToBytes(a.slice("sha256:".length)), `5820${a.slice("sha256:".length)}`],
  ])("writes %s one way, and reads it back", (_, value, hex) => {
    expect(bytesToHex(encodeObject(anything, { v: value }).bytes)).toBe(objectHexHolding(hex));
    expect(decodeHex(objectHexHolding(hex)).data).toEqual({ v: value });
  });

  it("keeps a member named __proto__ as a member", () => {
    const source = JSON.parse('{"__proto__":{"__proto__":1}}');
    const data = decodeObject(encodeObject(anything, source).bytes, anything).data;
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(Object.entries(data)).toEqual([["__proto__", JSON.parse('{"__proto__":1}')]]);
  });

  it("is refused when its data does not fit its schema", () => {
    const titledSchema = encodeSchema({ fields: ["title"] }, fieldNames);
    expect(encodeObject(titledSchema, { title: "hello" }).data).toEqual({ title: "hello" });
    expect(() => encodeObject(titledSchema, { text: "hello" })).toThrow(/does not fit/);
  });

  it("is refused when read with a schema other than its own", () => {
    const other = encodeSchema({ fields: ["text"] }, fieldNames);
    expect(() => decodeObject(encodeObject(anything, { text: "hello" }).bytes, other)).toThrow(/is written to/);
  });
});

describe("strict decoding", () => {
  const sha512Tag = "d94850";

  it.each([
    ["an integer in a longer head", objectHexHolding("1801")],
    ["a length in a longer head", objectHexHolding("780161")],
    ["the tag of the format in a longer head", `db00000000656f662182${linkHex(anything.link)}a0`],
    ["the tag of a link in a longer head", objectHexHolding(`da0000486c5820${a.slice("sha256:".length)}`)],
    ["keys out of order", objectHex("a2616201616101")],
    ["a longer key before a shorter one", objectHex("a262616101616201")],
    ["a repeated key", objectHex("a2616101616101")],
    ["an array of indefinite length", objectHexHolding("9f01ff")],
    ["a map of indefinite length", objectHexHolding("bf616101ff")],
    ["a string of indefinite length", objectHexHolding("7f6161ff")],
    ["bytes of indefinite length", objectHexHolding("5f4101ff")],
    ["a float", objectHexHolding("f93e00")],
    ["an integer written as a float", objectHexHolding("f93c00")],
    ["negative zero", objectHexHolding("f98000")],
    ["NaN", objectHexHolding("f97e00")],
    ["Infinity", objectHexHolding("f97c00")],
    ["null", objectHexHolding("f6")],
    ["undefined", objectHexHolding("f7")],
    ["a simple value", objectHexHolding("f0")],
    ["2^53", objectHexHolding("1b0020000000000000")],
    ["-(2^53)", objectHexHolding("3b001fffffffffffff")],
    ["a bignum", objectHexHolding("c249010000000000000000")],
    ["a tag other than that of a link", objectHexHolding("d82a4100")],
    ["a hash under the tag of SHA-512", objectHexHolding(`${sha512Tag}5840${"00".repeat(64)}`)],
    ["a link of 31 bytes", objectHexHolding(`d9486c581f${"00".repeat(31)}`)],
    ["a link of 33 bytes", objectHexHolding(`d9486c5821${"00".repeat(33)}`)],
    ["a link around a string", objectHexHolding("d9486c6161")],
    ["an object inside its data", objectHexHolding(objectHex("a0"))],
    ["a key that is not a string", objectHex("a10101")],
    ["invalid UTF-8 in a string", objectHexHolding("61ff")],
    ["invalid UTF-8 in a key", objectHex("a161ff01")],
    ["a surrogate written in UTF-8", objectHexHolding("63eda080")],
    ["a byte after the object", `${objectHex("a0")}00`],
    ["a second object after the first", objectHex("a0").repeat(2)],
    ["no bytes", ""],
    ["a map under no tag", "a0"],
    ["a schema and data under no tag", `82${linkHex(anything.link)}a0`],
    ["a link under no tag of the format", linkHex(anything.link)],
    ["a schema without data", `da656f662181${linkHex(anything.link)}`],
    ["a third item after its data", `da656f662183${linkHex(anything.link)}a0a0`],
    ["data that is not a map", `${objectHead}${linkHex(anything.link)}80`],
    ["a schema named by a string other than self", objectHex("a0", "64726f6f74")],
    ["a schema named by Self", objectHex("a0", "6453656c66")],
    ["a schema named by a hash that is bytes", objectHex("a0", `5820${a.slice("sha256:".length)}`)],
  ])("refuses %s", (_, hex) => {
    expect(() => objectFormat.decode(hexToBytes(hex))).toThrow();
  });

  it("reads the same bytes written the one way", () => {
    expect(decodeHex(objectHexHolding("01")).data).toEqual({ v: 1 });
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
    ["an object inside data", new ObjectValue(anything.link, {})],
  ])("refuses %s", (_, value) => {
    expect(() => encodeObject(anything, { v: value as Value })).toThrow();
    expect(() => encodeObject(anything, { v: [{ nested: value as Value }] })).toThrow();
  });

  it.each([1, 64, 100, 5000])("gives plain bytes, not a Node Buffer, around %i bytes", (length) => {
    const bytes = objectFormat.encode(new ObjectValue(anything.link, { v: new Uint8Array(length) }));
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(objectFormat.decode(bytes)).toEqual(new ObjectValue(anything.link, { v: new Uint8Array(length) }));
  });

  it("refuses a link that is not one", () => {
    expect(() => new LinkValue("sha256:ABC" as Link<never>)).toThrow();
    expect(() => objectFormat.encode(new ObjectValue("note" as Link<never>, {}))).toThrow();
  });
});

describe("an object written to itself", () => {
  const selfWritten = objectFormat.encode(new ObjectValue(itself, { title: "Anything" }));

  it("names its schema by the string self, in place of a link", () => {
    expect(bytesToHex(selfWritten)).toBe(`${objectHead}${itselfHex}a1657469746c6568416e797468696e67`);
    expect(objectFormat.decode(selfWritten).schema).toBe(itself);
  });

  it("reads back with its own link as its schema", () => {
    expect(schemaOf(selfWritten)).toBe(linkOf(selfWritten));
    const root = rootSchemaOf(fieldNames);
    const bytes: Uint8Array = root.bytes;
    const object = decodeObject(bytes, root);
    expect(object.schema.link).toBe(object.link);
    expect(object.data).toEqual({ fields: ["fields"] });
  });

  it("is refused as an object of another schema", () => {
    const bytes = objectFormat.encode(new ObjectValue(itself, { text: "hello" }));
    expect(schemaOf(bytes)).toBe(linkOf(bytes));
    expect(() => decodeObject(bytes, anything)).toThrow(/is written to/);
  });

  it("does not link to itself", () => {
    expect([...objectFormat.links(objectFormat.decode(selfWritten))]).toEqual([]);
    const linkingBytes = objectFormat.encode(new ObjectValue(itself, { to: new LinkValue(a) }));
    expect([...objectFormat.links(objectFormat.decode(linkingBytes))]).toEqual([a]);
  });
});

describe("the links in an object", () => {
  it("are the ones under the tag of a link, at any depth, its schema among them", () => {
    const object = encodeObject(anything, {
      list: [new LinkValue(a), { nested: [new LinkValue(b)] }],
      again: new LinkValue(b),
    });
    expect([...objectFormat.links(objectFormat.decode(object.bytes))].sort()).toEqual([anything.link, a, b, b].sort());
  });

  it("leave out a hash that is bytes, and a string that reads as a link, as a member or as a key", () => {
    const value = new ObjectValue(anything.link, {
      hash: hexToBytes(a.slice("sha256:".length)),
      text: a,
      map: { [a]: 1 },
    });
    expect([...objectFormat.links(value)]).toEqual([anything.link]);
  });
});
