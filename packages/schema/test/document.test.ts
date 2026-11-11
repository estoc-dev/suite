import { decodeSchema, type JsonObject, json, schemaOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { array, integer, link, optional, schema, schemaRoot, schemaValidator, string } from "../src/index.ts";

const written = (data: JsonObject) => json.encode(json.object(data, schemaRoot.link));

describe("the root", () => {
  it("describes itself, and stands for the language", () => {
    expect(new TextDecoder().decode(schemaRoot.bytes)).toBe('{"$schema":null,"language":"Estoc Schema"}');
    expect(schemaOf(schemaRoot.bytes, json)).toBe(schemaRoot.link);
  });
});

describe("a schema", () => {
  it("is an object of the root holding its title and its fields", () => {
    const note = schema("Note", { text: string(), parents: array(link()), at: optional(integer()) });
    expect(json.decode(note.bytes)).toEqual({
      $schema: { $link: schemaRoot.link },
      title: "Note",
      fields: {
        text: { type: "string" },
        parents: { type: "array", items: { type: "link" } },
        at: { type: "integer", optional: true },
      },
    });
    expect(note.blobs).toEqual([note.bytes, schemaRoot.bytes]);
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
});

describe("schema", () => {
  it("refuses a field named $schema", () => {
    expect(() => schema("Note", { $schema: string() })).toThrow(/not named \$schema/);
  });
});
