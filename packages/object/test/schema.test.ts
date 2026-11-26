import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  decodeObject,
  decodeSchema,
  encodeObject,
  encodeSchema,
  itself,
  LinkValue,
  ObjectValue,
  objectFormat,
  rootSchema,
  schemaOf,
  type ValueMap,
} from "../src/index.ts";
import { documentHolding, schemaTaking } from "./documents.ts";

const loginDocument = documentHolding("Login", "audience", "nonce");
const login = encodeSchema(loginDocument);
const other = schemaTaking("title", "fields");
const written = (data: ValueMap) => objectFormat.encode(new ObjectValue(rootSchema.link, data));
const dataOf = (bytes: Uint8Array) => objectFormat.decode(bytes).data;

describe("decodeSchema", () => {
  it("reads back what encodeSchema wrote, an object of its document written to the root schema", () => {
    const read = decodeSchema(login.bytes);
    expect(read.bytes).toEqual(login.bytes);
    expect(read.link).toBe(login.link);
    expect(dataOf(read.bytes)).toEqual(loginDocument);
    expect(read.document).toEqual(loginDocument);
    expect(schemaOf(read.bytes)).toBe(rootSchema.link);
  });

  it("reads a schema written out by hand", () => {
    expect(decodeSchema(written(loginDocument)).link).toBe(login.link);
  });

  it.each<[string, ValueMap]>([
    ["no fields at all", { title: "Note", fields: {} }],
    [
      "arrays of arrays",
      { title: "Note", fields: { rows: { type: "array", items: { type: "array", items: { type: "string" } } } } },
    ],
    [
      "an optional array",
      { title: "Note", fields: { tags: { type: "array", items: { type: "string" }, optional: true } } },
    ],
    ["an array of any values", { title: "Note", fields: { values: { type: "array", items: { type: "any" } } } }],
    [
      "a field of any name, as an object keeps none for its schema",
      { title: "Note", fields: { $schema: { type: "string" }, schema: { type: "link" } } },
    ],
  ])("reads a schema with %s", (_, data) => {
    const bytes = written(data);
    expect(decodeSchema(bytes).bytes).toEqual(bytes);
  });

  it.each<[string, Uint8Array, RegExp]>([
    ["bytes that are no object", new TextEncoder().encode('{"title":"Login","fields":{}}'), /./],
    [
      "an object written to another schema, though its data is a title and fields",
      encodeObject(other, { title: "Login", fields: {} }).bytes,
      /is written to/,
    ],
    [
      "an object written to itself that is not the root schema",
      objectFormat.encode(new ObjectValue(itself, { title: "Login", fields: {} })),
      /is written to/,
    ],
  ])("refuses %s", (_, bytes, reason) => {
    expect(() => decodeSchema(bytes)).toThrow(reason);
  });

  it.each<[string, ValueMap, RegExp]>([
    ["without a title", { fields: {} }, /#\/title: left out/],
    ["whose title is not a string", { title: 1, fields: {} }, /#\/title: not a string/],
    ["without fields", { title: "Note" }, /#\/fields: left out/],
    ["whose fields are an array", { title: "Note", fields: [] }, /holds fields/],
    [
      "with another member",
      { title: "Note", fields: {}, description: "A note." },
      /#\/description: not a field of the schema/,
    ],
    ["with a field that is a type by name", { title: "Note", fields: { text: "string" } }, /the field text is a map/],
    ["with a field of no type", { title: "Note", fields: { text: {} } }, /the type of the field text is one of/],
    [
      "with a field of a type that is none of the seven",
      { title: "Note", fields: { at: { type: "number" } } },
      /one of array, link/,
    ],
    [
      "with a field holding another member",
      { title: "Note", fields: { text: { type: "string", title: "Text" } } },
      /not title/,
    ],
    ["with an array of nothing", { title: "Note", fields: { tags: { type: "array" } } }, /says what its items are/],
    [
      "with items in what is not an array",
      { title: "Note", fields: { text: { type: "string", items: { type: "string" } } } },
      /has no items/,
    ],
    [
      "with a field marked optional with false",
      { title: "Note", fields: { text: { type: "string", optional: false } } },
      /optional with true/,
    ],
    [
      "with optional items",
      { title: "Note", fields: { tags: { type: "array", items: { type: "string", optional: true } } } },
      /the items of the field tags holds .*, not optional/,
    ],
    [
      "with items holding another member",
      { title: "Note", fields: { tags: { type: "array", items: { type: "string", title: "Tag" } } } },
      /the items of the field tags holds .*, not title/,
    ],
    [
      "that holds a link, which no place in a document takes",
      { title: "Note", fields: { text: new LinkValue(login.link) } },
      /the field text is a map/,
    ],
  ])("refuses a schema %s", (_, data, reason) => {
    expect(() => decodeSchema(written(data))).toThrow(reason);
  });

  it("refuses at compile time the bytes of an object of another schema", () => {
    const object = encodeObject(other, { title: "Login", fields: {} });
    // @ts-expect-error: the bytes are those of an object, not of a schema
    expect(() => decodeSchema(object.bytes)).toThrow(/is written to/);
  });
});

describe("a schema", () => {
  it("links to its root schema alone, so its closure is the two of them", () => {
    expect([...objectFormat.links(objectFormat.decode(login.bytes))]).toEqual([rootSchema.link]);
    expect(login.blobs).toEqual([login.bytes, rootSchema.bytes]);
    expect(encodeSchema({ title: "Chat", fields: { text: { type: "string" } } }).bytes).toHaveLength(81);
  });

  it("is an object of its root schema, and of no other schema", () => {
    const bytes: Uint8Array = login.bytes;
    expect(decodeObject(bytes, rootSchema).data).toEqual(loginDocument);
    expect(() => decodeObject(bytes, other)).toThrow(/is written to/);
  });

  it("is one blob however its fields are ordered", () => {
    const one = encodeSchema({ title: "Note", fields: { text: { type: "string" }, at: { type: "integer" } } });
    const reordered = encodeSchema({ title: "Note", fields: { at: { type: "integer" }, text: { type: "string" } } });
    expect(reordered.link).toBe(one.link);
  });

  it("is another blob under another title", () => {
    expect(encodeSchema(documentHolding("Comment", "audience", "nonce")).link).not.toBe(login.link);
  });
});

describe("the root schema", () => {
  const document = { title: "Schema", fields: { title: { type: "string" }, fields: { type: "any" } } };

  it("is the schema of a title and fields, written to itself", () => {
    expect(objectFormat.decode(rootSchema.bytes)).toEqual({ schema: itself, data: document });
    expect(rootSchema.bytes).toHaveLength(69);
    expect(schemaOf(rootSchema.bytes)).toBe(rootSchema.link);
    expect(bytesToHex(rootSchema.bytes)).toMatch(/^da656f663f826473656c66a2/);
  });

  it("has the link of its bytes as they were written out by hand elsewhere", () => {
    // The CBOR was written by hand in Python and hashed with its hashlib.
    expect(rootSchema.link).toBe("sha256:0ca86dbda2c90f10b57610d2174c9c1d71169926bbef6522bea63e926d33765b");
  });

  it("holds data that fits it, and reads as a schema", () => {
    expect(rootSchema.validate(dataOf(rootSchema.bytes))).toEqual(document);
    expect(decodeSchema(rootSchema.bytes)).toBe(rootSchema);
  });

  it("links to nothing, so it is its whole closure", () => {
    expect([...objectFormat.links(objectFormat.decode(rootSchema.bytes))]).toEqual([]);
    expect(rootSchema.blobs).toEqual([rootSchema.bytes]);
  });

  it("is not the schema encoded from its document, which is written to it", () => {
    const encoded = encodeSchema(rootSchema.document);
    expect(dataOf(encoded.bytes)).toEqual(document);
    expect(schemaOf(encoded.bytes)).toBe(rootSchema.link);
    expect(encoded.link).not.toBe(rootSchema.link);
    expect(decodeSchema(encoded.bytes).link).toBe(encoded.link);
  });

  it("takes the data of every schema, and of nothing that lacks a title or fields", () => {
    expect(() => rootSchema.validate(dataOf(login.bytes))).not.toThrow();
    expect(() => rootSchema.validate({ text: "hello" })).toThrow(/#\/text: not a field of the schema/);
  });
});

describe("the problems in data", () => {
  it("are none where the data fits, and one for each member or field that does not", () => {
    expect(login.problemsIn({ audience: "https://app.estoc.dev", nonce: "6f1c" })).toEqual([]);
    expect(login.problemsIn({ audience: "https://app.estoc.dev", more: 1 })).toEqual([
      "#/more: not a field of the schema",
      "#/nonce: left out",
    ]);
  });
});
