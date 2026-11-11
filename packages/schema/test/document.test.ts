import { decodeSchema, encodeObject, type Json, json, schemaOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { array, integer, link, optional, schema, schemaValidator, string } from "../src/index.ts";

const written = (document: Json) => json.encode(document);

describe("a schema", () => {
  it("is its title and its fields as bytes, which name no schema", () => {
    const note = schema("Note", { text: string(), parents: array(link()), at: optional(integer()) });
    expect(() => schemaOf(note.bytes, json)).toThrow(/names its schema/);
    expect(json.decode(note.bytes)).toEqual({
      title: "Note",
      fields: {
        text: { type: "string" },
        parents: { type: "array", items: { type: "link" } },
        at: { type: "integer", optional: true },
      },
    });
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

  it.each([
    ["no fields at all", { title: "Note", fields: {} }],
    [
      "arrays of arrays",
      { title: "Note", fields: { rows: { type: "array", items: { type: "array", items: { type: "string" } } } } },
    ],
    [
      "an optional array",
      { title: "Note", fields: { tags: { type: "array", items: { type: "string" }, optional: true } } },
    ],
  ])("is read with %s", (_, data) => {
    const bytes = written(data);
    expect(decodeSchema(bytes, schemaValidator).bytes).toEqual(bytes);
  });

  it.each([
    ["without a title", { fields: {} }, /holds a title/],
    ["whose title is not a string", { title: 1, fields: {} }, /holds a title/],
    ["without fields", { title: "Note" }, /holds fields/],
    ["whose fields are an array", { title: "Note", fields: [] }, /holds fields/],
    ["with another member", { title: "Note", fields: {}, description: "A note." }, /alone, not description/],
    ["with a $schema that is null", { $schema: null, title: "Note", fields: {} }, /alone, not \$schema/],
    ["when it is an array", [], /a schema is a JSON object/],
    ["with a field named $schema", { title: "Note", fields: { $schema: { type: "string" } } }, /not named \$schema/],
    [
      "with a field that is a type by name",
      { title: "Note", fields: { text: "string" } },
      /the field text is a JSON object/,
    ],
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

  it("is refused as an object written to a schema, though its data is a title and fields", () => {
    const note = schema("Note", { title: string(), fields: array(string()) });
    const object = encodeObject(note, { title: "Note", fields: [] });
    // @ts-expect-error: refused at compile time too
    expect(() => decodeSchema(object.bytes, schemaValidator)).toThrow(/links to nothing/);
  });
});

describe("schema", () => {
  it("refuses a field named $schema", () => {
    expect(() => schema("Note", { $schema: string() })).toThrow(/not named \$schema/);
  });
});
