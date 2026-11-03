import { encodeSchema, type JsonObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { commentSchema } from "../src/index.ts";

const schema = await encodeSchema(commentSchema, defaultValidator);
const on = { $link: `sha256:${"ab".repeat(32)}` };

describe("the comment schema", () => {
  it("takes a comment on a blob, with its text and when it was written", () => {
    expect(() => schema.validate({ on, text: "looks right", at: 0 })).not.toThrow();
  });

  it.each<[string, JsonObject]>([
    ["without what it is on", { text: "looks right", at: 0 }],
    ["without text", { on, at: 0 }],
    ["without when", { on, text: "looks right" }],
    ["whose text is empty", { on, text: "", at: 0 }],
    ["on a string rather than a link", { on: on.$link, text: "looks right", at: 0 }],
    ["written before the epoch", { on, text: "looks right", at: -1 }],
    ["written at a fraction of a millisecond", { on, text: "looks right", at: 0.5 }],
    ["with a field of its own", { on, text: "looks right", at: 0, by: "alice" }],
  ])("refuses a comment %s", (_, data) => {
    expect(() => schema.validate(data)).toThrow();
  });
});
