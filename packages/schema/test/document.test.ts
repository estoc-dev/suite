import { objectFormat, rootSchema, schemaOf } from "@estoc/object";
import { expect, test } from "vitest";
import { any, array, integer, link, optional, schema, string } from "../src/index.ts";

test("a schema is the object of its title and its fields, written to the root schema", () => {
  const note = schema("Note", { text: string(), parents: array(link()), at: optional(integer()), more: any() });
  expect(schemaOf(note.bytes)).toBe(rootSchema.link);
  expect(objectFormat.decode(note.bytes).data).toEqual({
    title: "Note",
    fields: {
      text: { type: "string" },
      parents: { type: "array", items: { type: "link" } },
      at: { type: "integer", optional: true },
      more: { type: "any" },
    },
  });
});
