// @vitest-environment happy-dom
import { inspect } from "@estoc/inspector";
import { type Link, linkOf, ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { any, array, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { objectView } from "../src/object-view.ts";

async function viewOf(objectSchema: ReturnType<typeof schema>, data: ValueMap): Promise<HTMLElement> {
  const bytes = objectFormat.encode(new ObjectValue(objectSchema.link, data));
  const blobs = [bytes, ...objectSchema.blobs];
  const reader = new Map<Link<unknown>, Uint8Array>(blobs.map((blob) => [linkOf(blob), blob]));
  const inspection = await inspect(linkOf(bytes), reader);
  if (inspection.kind !== "object") throw new Error(`read as ${inspection.kind}`);
  return objectView(inspection);
}

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

describe("the view of an object", () => {
  it("lists once, under the schema, a problem that reads as that of more than one value", async () => {
    const named = schema("Named", { a: any(), "a/0": string(), label: string(), "label: detail": string() });
    const view = await viewOf(named, {
      a: ["valid nested text"],
      "a/0": 7,
      label: "valid field text",
      "label: detail": 8,
    });
    expect(textsOf(view, "table .problem")).toEqual([]);
    expect(textsOf(view, ".head .problem")).toEqual([
      "The data does not fit it: 2 problems.",
      "#/a/0: not a string",
      "#/label: detail: not a string",
    ]);
  });

  it("marks a problem at the value it is of", async () => {
    const view = await viewOf(schema("Note", { text: string(), tags: array(string()) }), { text: 7, tags: ["a", 8] });
    expect(textsOf(view, "tr")).toEqual([
      "FieldValueType",
      "tags" + "array · 2 items" + '0"a"' + "18not a string" + "array of string",
      "text7not a stringstring",
    ]);
  });
});
