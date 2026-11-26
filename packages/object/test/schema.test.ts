import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  itself,
  LinkValue,
  ObjectValue,
  objectFormat,
  rootSchemaOf,
  type SchemaValidator,
  schemaOf,
  type ValueMap,
} from "../src/index.ts";
import { anything, documentHolding, fieldNames, lenient } from "./field-names.ts";

const root = rootSchemaOf(fieldNames);
const loginDocument = documentHolding("Login", "audience", "nonce");
const login = encodeSchema(loginDocument, fieldNames);
const written = (data: ValueMap) => objectFormat.encode(new ObjectValue(root.link, data));
const dataOf = (bytes: Uint8Array) => objectFormat.decode(bytes).data;

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, an object of its document written to the root schema", () => {
    const read = decodeSchema(login.bytes, fieldNames);
    expect(read.bytes).toEqual(login.bytes);
    expect(read.link).toBe(login.link);
    expect(dataOf(read.bytes)).toEqual(loginDocument);
    expect(read.document).toEqual(loginDocument);
    expect(schemaOf(read.bytes)).toBe(root.link);
  });

  it("reads a schema written out by hand", () => {
    expect(decodeSchema(written(loginDocument), lenient).link).toBe(login.link);
  });

  it.each<[string, Uint8Array, RegExp]>([
    ["bytes that are no object", new TextEncoder().encode('{"title":"Login","fields":{}}'), /./],
    [
      "an object written to another schema",
      encodeObject(anything, { title: "Login", fields: {} }).bytes,
      /is written to/,
    ],
    [
      "an object written to itself that is not the root schema",
      objectFormat.encode(new ObjectValue(itself, { title: "Login", fields: {} })),
      /is written to/,
    ],
    [
      "a document holding more than the root schema takes",
      written({ title: "Login", fields: {}, description: "A login." }),
      /#\/description: not a field of the schema/,
    ],
  ])("refuses %s", (_, bytes, reason) => {
    expect(() => decodeSchema(bytes, fieldNames)).toThrow(reason);
  });

  it("refuses data that is not a document, whatever the validator", () => {
    expect(() => decodeSchema(written({ title: 1, fields: {} }), lenient)).toThrow(/holds a title/);
    expect(() => decodeSchema(written({ title: "Login", fields: [] }), lenient)).toThrow(/holds fields/);
    expect(() => decodeSchema(written({ title: "Login", fields: { nonce: "string" } }), lenient)).toThrow(/is a map/);
  });

  it("refuses a schema that holds a link, which no place in a document takes", () => {
    const fields = { nonce: new LinkValue(anything.link) };
    expect(() => decodeSchema(written({ title: "Login", fields }), lenient)).toThrow(/the field nonce is a map/);
  });
});

describe("a schema", () => {
  it("links to its root schema alone, so its closure is the two of them", () => {
    expect([...objectFormat.links(objectFormat.decode(login.bytes))]).toEqual([root.link]);
    expect(login.blobs).toEqual([login.bytes, root.bytes]);
  });

  it("is an object of its root schema, and of no other schema", () => {
    const bytes: Uint8Array = login.bytes;
    expect(decodeObject(bytes, root).data).toEqual(loginDocument);
    expect(() => decodeObject(bytes, anything)).toThrow(/is written to/);
  });
});

describe("the root schema", () => {
  it("is written to itself, and its bytes start as those of every object do", () => {
    expect(objectFormat.decode(root.bytes).schema).toBe(itself);
    expect(schemaOf(root.bytes)).toBe(root.link);
    expect(bytesToHex(root.bytes)).toMatch(/^da656f663f826473656c66a2/);
  });

  it("holds data that fits it, and reads as a schema", () => {
    expect(() => root.validate(dataOf(root.bytes))).not.toThrow();
    expect(decodeSchema(root.bytes, fieldNames)).toBe(root);
  });

  it("links to nothing, so it is its whole closure", () => {
    expect([...objectFormat.links(objectFormat.decode(root.bytes))]).toEqual([]);
    expect(root.blobs).toEqual([root.bytes]);
  });

  it("is one blob, whichever validator compiles it", () => {
    expect(rootSchemaOf(lenient).bytes).toEqual(root.bytes);
    expect(rootSchemaOf(fieldNames)).toBe(root);
  });

  it("is refused when its own data does not fit it", () => {
    const misfit: SchemaValidator = { compile: () => () => ["#/title: refused"] };
    expect(() => rootSchemaOf(misfit)).toThrow(/does not fit/);
    expect(() => encodeSchema(loginDocument, misfit)).toThrow(/does not fit/);
  });
});

const evenOnly: SchemaValidator = {
  compile:
    () =>
    ({ n }) =>
      typeof n === "number" && n % 2 !== 0 ? ["odd"] : [],
};
const even = encodeSchema(documentHolding("Even", "n"), evenOnly);

describe("a validator", () => {
  it("decides what an object may hold, when encoding and when decoding", () => {
    expect(encodeObject(even, { n: 2 }).data).toEqual({ n: 2 });
    expect(() => encodeObject(even, { n: 3 })).toThrow();
    const lenientEven = decodeSchema(even.bytes, lenient);
    const odd = encodeObject(lenientEven, { n: 3 });
    expect(() => decodeObject(odd.bytes, even)).toThrow();
  });

  it("refusing to compile a schema leaves no schema", () => {
    const refusing: SchemaValidator = {
      compile() {
        throw new Error("unsupported");
      },
    };
    expect(() => encodeSchema(documentHolding("Even", "n"), refusing)).toThrow("unsupported");
    expect(() => decodeSchema(even.bytes, refusing)).toThrow("unsupported");
  });
});

test("the same bytes read by two validators give one link", () => {
  const read = decodeSchema(login.bytes, lenient);
  expect(read.link).toBe(decodeSchema(login.bytes, fieldNames).link);
  expect(() => read.validate({ m: 1 })).not.toThrow();
});
