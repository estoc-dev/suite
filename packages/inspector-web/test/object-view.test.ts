// @vitest-environment happy-dom
import { markdownBodyOf, markdownBodySchema } from "@estoc/blog";
import { inspect } from "@estoc/inspector";
import { AbsentBlob, type Link, linkOf, ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { any, array, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { fragmentOf } from "../src/address.ts";
import { bodyReading } from "../src/body-reading.ts";
import { objectView } from "../src/object-view.ts";
import type { Reading } from "../src/reading.ts";
import { signatureReading } from "../src/signature-reading.ts";

async function viewOf(
  objectSchema: ReturnType<typeof schema>,
  data: ValueMap,
  reading?: Reading,
): Promise<HTMLElement> {
  const bytes = objectFormat.encode(new ObjectValue(objectSchema.link, data));
  const blobs = [bytes, ...objectSchema.blobs];
  const reader = new Map<Link<unknown>, Uint8Array>(blobs.map((blob) => [linkOf(blob), blob]));
  const inspection = await inspect(linkOf(bytes), reader);
  if (inspection.kind !== "object") throw new Error(`read as ${inspection.kind}`);
  return objectView(inspection, reading);
}

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

const partsOf = (view: HTMLElement) => Array.from(view.children, ({ className, tagName }) => className || tagName);

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

  it("shows the body the page reads the object as, rendered above its fields", async () => {
    const view = await viewOf(
      markdownBodySchema,
      { text: "a *word*" },
      { kind: "read", as: bodyReading, value: markdownBodyOf("a *word*") },
    );
    expect(textsOf(view, ".reading .band")).toEqual(["Read by this page as the body of a post"]);
    expect(textsOf(view, ".rendered em")).toEqual(["word"]);
    expect(partsOf(view)).toEqual(["head", "reading", "TABLE"]);
  });

  it("says above its fields why the page could not read the object as a body", async () => {
    const error = new Error("the data does not fit its schema: #/text: not a string");
    const view = await viewOf(markdownBodySchema, { text: 7 }, { kind: "unread", as: bodyReading, error });
    expect(textsOf(view, ".reading p")).toEqual(["Not read by this page as the body of a post", error.message]);
    expect(view.querySelector(".rendered")).toBeNull();
    expect(partsOf(view)).toEqual(["head", "reading", "TABLE"]);
  });

  it("names, as a link to follow, the link that a reading had no blob for", async () => {
    const { link } = markdownBodyOf("a signed identity the file leaves out");
    const view = await viewOf(
      schema("Signature", { signedIdentity: string() }),
      { signedIdentity: link },
      { kind: "unread", as: signatureReading, error: new AbsentBlob(link) },
    );
    expect(textsOf(view, ".reading p")).toEqual([
      "Not read by this page as a signature",
      `No blob is given for ${link}.`,
    ]);
    expect(view.querySelector(".reading a")?.getAttribute("href")).toBe(fragmentOf(link));
    expect(view.querySelector(".reading .problem")).toBeNull();
  });

  it("shows the fields alone where the page does not read the schema of the object", async () => {
    const view = await viewOf(schema("Note", { text: string() }), { text: "<em>a word</em>" });
    expect(view.querySelector(".reading")).toBeNull();
    expect(view.querySelector("em")).toBeNull();
  });
});
