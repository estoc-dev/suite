import type { Json } from "@estoc/object";
import { describe, expect, it, test } from "vitest";
import { array, boolean, bytes, integer, link, optional, schema, string } from "../src/index.ts";

const blob = { $link: `sha256:${"0f".repeat(32)}` };
const fitting = (value: Json) => [JSON.stringify(value), value] as const;

describe.each([
  ["an integer", integer(), [0, -1, 2 ** 53 - 1, -(2 ** 53 - 1)], [2 ** 53, -(2 ** 53), 1e21, 1.5, "1", true, null]],
  ["bytes", bytes(), ["", "00ff", "0123456789abcdef"], ["0", "0F", "0g", "0x00", " 00", 0, null]],
  ["a link", link(), [blob], [blob.$link, { $link: "sha256:0f" }, { ...blob, more: 1 }, {}, null]],
  ["a string", string(), ["", "text", "00ff"], [0, true, null, ["text"], blob]],
  ["a boolean", boolean(), [true, false], [0, "true", null]],
  ["an array", array(string()), [[], ["a"], ["a", "b"]], ["a", { 0: "a" }, null]],
] as const)("%s", async (_, type, taken, refused) => {
  const holder = await schema("Holder", { value: type });

  it.each(taken.map(fitting))("takes %s", (_, value) => {
    expect(holder.validate({ value })).toEqual({ value });
  });

  it.each((refused as readonly Json[]).map(fitting))("does not take %s", (_, value) => {
    expect(() => holder.validate({ value })).toThrow(/#\/value: not /);
  });
});

describe("an array", () => {
  it("says which of its items does not fit", async () => {
    const holder = await schema("Holder", { rows: array(array(integer())) });
    expect(() => holder.validate({ rows: [[1], [2, "3"]] })).toThrow("#/rows/1/1: not an integer");
    expect(() => holder.validate({ rows: [[1], 2] })).toThrow("#/rows/1: not an array");
  });
});

describe("the data of an object", async () => {
  const note = await schema("Note", { text: string(), at: integer(), isDraft: optional(boolean()) });

  it("fits with every field, and with an optional one left out", () => {
    expect(note.validate({ text: "", at: 0, isDraft: true })).toEqual({ text: "", at: 0, isDraft: true });
    expect(note.validate({ text: "", at: 0 })).toEqual({ text: "", at: 0 });
  });

  it("does not fit with a field left out that is not optional", () => {
    expect(() => note.validate({ text: "" })).toThrow("#/at: left out");
  });

  it("does not fit with a member that is no field", () => {
    expect(() => note.validate({ text: "", at: 0, more: 1 })).toThrow("#/more: not a field of the schema");
  });

  it("does not fit with an optional field that holds another type, null included", () => {
    expect(() => note.validate({ text: "", at: 0, isDraft: null })).toThrow("#/isDraft: not a boolean");
  });

  it("is told everything that does not fit, the fields in the order the schema's bytes hold them", () => {
    expect(() => note.validate({ text: 1, more: 1 })).toThrow(
      "#/more: not a field of the schema; #/at: left out; #/text: not a string",
    );
  });
});

test("a name every object inherits is a field or a member only where it is written", async () => {
  const note = await schema("Note", { text: string() });
  expect(() => note.validate({ text: "", constructor: "" })).toThrow("#/constructor: not a field");
  const named = await schema("Named", { constructor: string() });
  expect(() => named.validate({})).toThrow("#/constructor: left out");
});
