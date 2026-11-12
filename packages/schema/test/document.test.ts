import { decodeSchema, type EstMap, encodeObject, est, itself, schemaOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { any, array, integer, link, optional, rootSchema, schema, schemaValidator, string } from "../src/index.ts";

const written = (data: EstMap) => est.encode(est.object(data, rootSchema.link));
const dataOf = (bytes: Uint8Array) => est.fields(est.decode(bytes)).data;

describe("a schema", () => {
  it("is the object of its title and its fields, written to the root schema", () => {
    const note = schema("Note", { text: string(), parents: array(link()), at: optional(integer()), more: any() });
    expect(schemaOf(note.bytes, est)).toBe(rootSchema.link);
    expect(dataOf(note.bytes)).toEqual({
      title: "Note",
      fields: {
        text: { type: "string" },
        parents: { type: "array", items: { type: "link" } },
        at: { type: "integer", optional: true },
        more: { type: "any" },
      },
    });
  });

  it("comes with the root schema, the two of them its closure", () => {
    const chat = schema("Chat", { text: string() });
    expect(chat.bytes).toHaveLength(81);
    expect(chat.blobs).toEqual([chat.bytes, rootSchema.bytes]);
    expect([...est.links(est.decode(chat.bytes))]).toEqual([rootSchema.link]);
  });

  it("is one blob however its fields are ordered", () => {
    const one = schema("Note", { text: string(), at: integer() });
    const other = schema("Note", { at: integer(), text: string() });
    expect(other.link).toBe(one.link);
  });

  it("is another blob under another title", () => {
    const one = schema("Note", { text: string() });
    const other = schema("Comment", { text: string() });
    expect(other.link).not.toBe(one.link);
  });

  it.each<[string, EstMap]>([
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
  ])("is read with %s", (_, data) => {
    const bytes = written(data);
    expect(decodeSchema(bytes, schemaValidator).bytes).toEqual(bytes);
  });

  it.each<[string, EstMap, RegExp]>([
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
      "with a field of a type the language has not",
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
  ])("is refused %s", (_, data, reason) => {
    expect(() => decodeSchema(written(data), schemaValidator)).toThrow(reason);
  });

  it("is refused when it is written to another schema, though its data is a title and fields", () => {
    const note = schema("Note", { title: string(), fields: any() });
    const object = encodeObject(note, { title: "Note", fields: {} });
    // @ts-expect-error: refused at compile time too
    expect(() => decodeSchema(object.bytes, schemaValidator)).toThrow(/is written to/);
  });

  it("is refused when it is written to itself, as the root schema alone is", () => {
    const bytes = est.encode(est.object({ title: "Note", fields: {} }, itself));
    expect(() => decodeSchema(bytes, schemaValidator)).toThrow(/is written to/);
  });
});

describe("the root schema", () => {
  const document = { title: "Schema", fields: { title: { type: "string" }, fields: { type: "any" } } };

  it("is the schema of a title and fields, written to itself", () => {
    expect(est.fields(est.decode(rootSchema.bytes))).toEqual({ schema: itself, data: document });
    expect(rootSchema.bytes).toHaveLength(69);
    expect(schemaOf(rootSchema.bytes, est)).toBe(rootSchema.link);
  });

  it("has the link of its bytes as they were written out by hand elsewhere", () => {
    // The CBOR was written by hand in Python and hashed with its hashlib.
    expect(rootSchema.link).toBe("sha256:f04c343e9b0209f633e0670c03798f9d5408fd69e7835ffb637847875a38e08e");
  });

  it("holds data that fits it, and reads as a schema of the language", () => {
    expect(rootSchema.validate(dataOf(rootSchema.bytes))).toEqual(document);
    expect(decodeSchema(rootSchema.bytes, schemaValidator)).toBe(rootSchema);
  });

  it("links to nothing, so it is its whole closure", () => {
    expect([...est.links(est.decode(rootSchema.bytes))]).toEqual([]);
    expect(rootSchema.blobs).toEqual([rootSchema.bytes]);
  });

  it("takes the data of every schema, and of nothing that lacks a title or fields", () => {
    const note = schema("Note", { text: string() });
    expect(() => rootSchema.validate(dataOf(note.bytes))).not.toThrow();
    expect(() => rootSchema.validate({ text: "hello" })).toThrow(/#\/text: not a field of the schema/);
  });
});
