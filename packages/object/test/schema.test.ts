import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import {
  decodeObject,
  decodeSchema,
  type Est,
  EstLink,
  encodeObject,
  encodeSchema,
  est,
  itself,
  rootSchemaOf,
  type SchemaValidator,
  schemaOf,
} from "../src/index.ts";
import { type FieldNames, fieldNames } from "./field-names.ts";

const lenient: SchemaValidator<Est, FieldNames> = { language: fieldNames.language, compile: () => () => [] };
const root = rootSchemaOf(fieldNames);
const login = encodeSchema({ fields: ["audience", "nonce"] }, fieldNames);
const anything = encodeSchema({ fields: "any" }, fieldNames);
const dataOf = (bytes: Uint8Array) => est.fields(est.decode(bytes)).data;

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, an object of its document written to the root schema", () => {
    const read = decodeSchema(login.bytes, fieldNames);
    expect(read.bytes).toEqual(login.bytes);
    expect(read.link).toBe(login.link);
    expect(dataOf(read.bytes)).toEqual({ fields: ["audience", "nonce"] });
    expect(schemaOf(read.bytes, est)).toBe(root.link);
  });

  it("reads a schema written out by hand", () => {
    const bytes = est.encode(est.object({ fields: ["audience", "nonce"] }, root.link));
    expect(decodeSchema(bytes, lenient).link).toBe(login.link);
  });

  it.each<[string, Uint8Array, RegExp]>([
    ["bytes that are no object", new TextEncoder().encode('{"fields":[]}'), /./],
    ["an object written to another schema", encodeObject(anything, { fields: [] }).bytes, /is written to/],
    [
      "an object written to itself that is not the root schema",
      est.encode(est.object({ fields: [] }, itself)),
      /is written to/,
    ],
    [
      "a document holding more than the root schema takes",
      est.encode(est.object({ fields: [], title: "Name" }, root.link)),
      /#\/title: not a field of the schema/,
    ],
  ])("refuses %s", (_, bytes, reason) => {
    expect(() => decodeSchema(bytes, fieldNames)).toThrow(reason);
  });

  it("refuses data that is not a document of the language, whatever the validator", () => {
    const schemaHolding = (fields: Est) => est.encode(est.object({ fields }, root.link));
    expect(() => decodeSchema(schemaHolding("audience"), lenient)).toThrow(/are names/);
    expect(() => decodeSchema(schemaHolding(["audience", 1]), lenient)).toThrow(/are names/);
  });

  it("refuses a schema that links to another blob than its root schema", () => {
    const bytes = est.encode(est.object({ fields: [new EstLink(anything.link)] }, root.link));
    expect(() => decodeSchema(bytes, lenient)).toThrow(`links to its root schema alone, not to ${anything.link}`);
  });
});

describe("a schema", () => {
  it("links to its root schema alone, so its closure is the two of them", () => {
    expect([...est.links(est.decode(login.bytes))]).toEqual([root.link]);
    expect(login.blobs).toEqual([login.bytes, root.bytes]);
  });

  it("is an object of its root schema, and of no other schema", () => {
    const bytes: Uint8Array = login.bytes;
    expect(decodeObject(bytes, root).data).toEqual({ fields: ["audience", "nonce"] });
    expect(() => decodeObject(bytes, anything)).toThrow(/is written to/);
  });
});

describe("the root schema", () => {
  it("is written to itself, and its bytes start as those of every object do", () => {
    expect(est.fields(est.decode(root.bytes)).schema).toBe(itself);
    expect(schemaOf(root.bytes, est)).toBe(root.link);
    const fieldsText = "666669656c6473";
    expect(bytesToHex(root.bytes)).toBe(`da6573743f826473656c66a1${fieldsText}81${fieldsText}`);
  });

  it("holds data that fits it, and reads as a schema of the language", () => {
    expect(() => root.validate(dataOf(root.bytes))).not.toThrow();
    expect(decodeSchema(root.bytes, fieldNames)).toBe(root);
  });

  it("links to nothing, so it is its whole closure", () => {
    expect([...est.links(est.decode(root.bytes))]).toEqual([]);
    expect(root.blobs).toEqual([root.bytes]);
  });

  it("is one blob for a language, whichever validator compiles it", () => {
    expect(rootSchemaOf(lenient).bytes).toEqual(root.bytes);
    expect(rootSchemaOf(fieldNames)).toBe(root);
  });

  it("is refused when its own data does not fit it", () => {
    const misfit: SchemaValidator<Est, FieldNames> = {
      ...fieldNames,
      language: { ...fieldNames.language, root: { fields: ["title"] } },
    };
    expect(() => rootSchemaOf(misfit)).toThrow(/does not fit/);
    expect(() => encodeSchema({ fields: [] }, misfit)).toThrow(/does not fit/);
  });
});

const evenOnly: SchemaValidator<Est, FieldNames> = {
  language: fieldNames.language,
  compile:
    () =>
    ({ n }) =>
      typeof n === "number" && n % 2 !== 0 ? ["odd"] : [],
};
const even = encodeSchema({ fields: ["n"] }, evenOnly);

describe("a validator", () => {
  it("decides what an object may hold, when encoding and when decoding", () => {
    expect(encodeObject(even, { n: 2 }).data).toEqual({ n: 2 });
    expect(() => encodeObject(even, { n: 3 })).toThrow();
    const lenientEven = decodeSchema(even.bytes, lenient);
    const odd = encodeObject(lenientEven, { n: 3 });
    expect(() => decodeObject(odd.bytes, even)).toThrow();
  });

  it("refusing to compile a schema leaves no schema", () => {
    const refusing: SchemaValidator<Est, FieldNames> = {
      language: fieldNames.language,
      compile() {
        throw new Error("unsupported");
      },
    };
    expect(() => encodeSchema({ fields: ["n"] }, refusing)).toThrow("unsupported");
    expect(() => decodeSchema(even.bytes, refusing)).toThrow("unsupported");
  });
});

test("the same bytes read by two validators give one link", () => {
  const read = decodeSchema(login.bytes, lenient);
  expect(read.link).toBe(decodeSchema(login.bytes, fieldNames).link);
  expect(() => read.validate({ m: 1 })).not.toThrow();
});
