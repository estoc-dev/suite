import { inspect } from "node:util";
import { LinkValue, type Value } from "@estoc/object";
import { describe, expect, it, test } from "vitest";
import { any, array, boolean, bytes, integer, link, optional, schema, string } from "../src/index.ts";

const blob = new LinkValue(`sha256:${"0f".repeat(32)}` as const);
const digest = new Uint8Array(32).fill(0x0f);
const named = (value: Value) => [inspect(value, { breakLength: Number.POSITIVE_INFINITY }), value] as const;

describe.each<[string, ReturnType<typeof any>, readonly Value[], readonly Value[]]>([
  ["an integer", integer(), [0, -1, 2 ** 53 - 1, -(2 ** 53 - 1)], [2 ** 53, -(2 ** 53), 1e21, 1.5, "1", true]],
  ["bytes", bytes(), [new Uint8Array(), Uint8Array.of(0, 255), digest], ["00ff", 0, [0, 255], blob]],
  ["a link", link(), [blob], [blob.link, digest, { link: blob.link }, {}]],
  ["a string", string(), ["", "text", "00ff"], [0, true, ["text"], blob, digest]],
  ["a boolean", boolean(), [true, false], [0, "true"]],
  ["an array", array(string()), [[], ["a"], ["a", "b"]], ["a", { 0: "a" }, Uint8Array.of(1)]],
  ["any value", any(), [0, "text", true, digest, blob, [1, "a"], {}, { a: { b: [blob] } }], []],
])("%s", (_, type, taken, refused) => {
  const holder = schema("Holder", { value: type });

  it.each(taken.map(named))("takes %s", (_, value) => {
    expect(holder.validate({ value })).toEqual({ value });
  });

  it.runIf(refused.length > 0).each(refused.map(named))("does not take %s", (_, value) => {
    expect(() => holder.validate({ value })).toThrow(/#\/value: not /);
  });
});

describe("an array", () => {
  it("says which of its items does not fit", () => {
    const holder = schema("Holder", { rows: array(array(integer())) });
    expect(() => holder.validate({ rows: [[1], [2, "3"]] })).toThrow("#/rows/1/1: not an integer");
    expect(() => holder.validate({ rows: [[1], 2] })).toThrow("#/rows/1: not an array");
  });
});

describe("the data of an object", () => {
  const note = schema("Note", { text: string(), at: integer(), isDraft: optional(boolean()) });

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

  it("does not fit with an optional field that holds another type", () => {
    expect(() => note.validate({ text: "", at: 0, isDraft: 0 })).toThrow("#/isDraft: not a boolean");
  });

  it("is told everything that does not fit, the fields in the order the schema's bytes hold them", () => {
    expect(() => note.validate({ text: 1, more: 1 })).toThrow(
      "#/more: not a field of the schema; #/at: left out; #/text: not a string",
    );
  });
});

test("a name every object inherits is a field or a member only where it is written", () => {
  const note = schema("Note", { text: string() });
  expect(() => note.validate({ text: "", constructor: "" })).toThrow("#/constructor: not a field");
  const named = schema("Named", { constructor: string() });
  expect(() => named.validate({})).toThrow("#/constructor: left out");
});
