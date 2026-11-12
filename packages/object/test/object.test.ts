import { createHash } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  EstLink,
  type EstMap,
  encodeObject,
  encodeSchema,
  est,
  readObject,
  schemaOf,
} from "../src/index.ts";
import { fieldNames } from "./field-names.ts";

const anything = encodeSchema({ fields: "any" }, fieldNames);
const login = encodeSchema({ fields: ["audience", "nonce"] }, fieldNames);
const greeting = { audience: "https://app.estoc.dev", nonce: "6f1c" };
const malformed: [string, Uint8Array][] = [
  ["of no bytes", new Uint8Array()],
  ["that is a map under no tag", hexToBytes("a0")],
  ["that is a link under no tag", hexToBytes(`d9486c5820${anything.link.slice("sha256:".length)}`)],
  ["written in JSON", new TextEncoder().encode(`{"$schema":{"$link":"${anything.link}"},"v":1}`)],
];

describe("an object", () => {
  it.each<[string, EstMap]>([
    ["fields", greeting],
    [
      "fields of every kind",
      { array: [1, "two", { three: true }], string: "hello", link: new EstLink(login.link), bytes: Uint8Array.of(1) },
    ],
    ["no fields", {}],
    ["a field of any name, as it keeps none for its schema", { $schema: "note", schema: new EstLink(login.link) }],
  ])("holding %s reads back with the same link", (_, data) => {
    const object = encodeObject(anything, data);
    const read = decodeObject(object.bytes, anything);
    expect(read.data).toEqual(data);
    expect(read.link).toBe(object.link);
    expect(read.schema).toBe(anything);
  });

  it("is linked by the SHA-256 of its bytes", () => {
    const object = encodeObject(login, greeting);
    expect(object.link).toBe(`sha256:${createHash("sha256").update(object.bytes).digest("hex")}`);
  });

  it("under another schema is another object", () => {
    expect(encodeObject(anything, greeting).link).not.toBe(encodeObject(login, greeting).link);
  });

  it("is refused when its data does not fit its schema", () => {
    expect(() => encodeObject(login, { audience: "https://app.estoc.dev" })).toThrow();
    const bytes = encodeObject(anything, { audience: "https://app.estoc.dev" }).bytes;
    expect(() => decodeObject(bytes, login)).toThrow();
  });

  it("is refused when read with a schema other than its own, even one its data fits", () => {
    expect(() => decodeObject(encodeObject(login, greeting).bytes, anything)).toThrow();
  });

  it.each(malformed)("is refused %s", (_, bytes) => {
    expect(() => decodeObject(bytes, anything)).toThrow();
  });
});

describe("an object read by its link", () => {
  const object = encodeObject(login, greeting);

  it("is the object whose blob the reader gives for the link", async () => {
    expect(await readObject(new Map([[object.link, object.bytes]]), object.link, login)).toEqual(object);
  });

  it("is refused when the reader gives no blob for the link", async () => {
    await expect(readObject(new Map(), object.link, login)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when the reader gives another blob for the link", async () => {
    const other = encodeObject(login, { ...greeting, nonce: "9a2e" });
    await expect(readObject(new Map([[object.link, other.bytes]]), object.link, login)).rejects.toThrow(
      /is another blob/,
    );
  });
});

describe("the schema an object names", () => {
  it("is read without the schema, whether or not the data fits it", () => {
    expect(schemaOf(encodeObject(login, greeting).bytes, est)).toBe(login.link);
    expect(schemaOf(est.encode(est.object({ v: 1 }, login.link)), est)).toBe(login.link);
  });

  it.each(malformed)("is not read from an object %s", (_, bytes) => {
    expect(() => schemaOf(bytes, est)).toThrow();
  });
});

test("an object read with a schema decoded from the same bytes keeps its link", () => {
  const object = encodeObject(login, greeting);
  const schema = decodeSchema(login.bytes, fieldNames);
  expect(decodeObject(object.bytes, schema).link).toBe(object.link);
});
