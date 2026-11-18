import { markdownBodyOf, markdownBodySchema } from "@estoc/blog";
import { inspect } from "@estoc/inspector";
import { encodeObject, type Link, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { readingOf } from "../src/reading.ts";

const readerOf = (blobs: readonly Uint8Array[]) =>
  new Map<Link<unknown>, Uint8Array>(blobs.map((blob) => [linkOf(blob), blob]));

async function readingAt(bytes: Uint8Array, others: readonly Uint8Array[] = []) {
  const reader = readerOf([bytes, ...others]);
  return readingOf(await inspect(linkOf(bytes), reader), reader);
}

const body = markdownBodyOf("## Identity\n");

describe("the reading of what a link reads as", () => {
  it("is the body that a Markdown body reads as", async () => {
    expect(await readingAt(body.bytes, markdownBodySchema.blobs)).toEqual({ kind: "read", body });
  });

  it("is the body where the reader has no blob for the schema of the body", async () => {
    expect(await readingAt(body.bytes)).toEqual({ kind: "read", body });
  });

  it("is nothing for an object of a schema of the same title that has another field", async () => {
    const lookalike = schema("Markdown Body", { text: string(), more: string() });
    const { bytes } = encodeObject(lookalike, { text: "## Identity\n", more: "" });
    expect(await readingAt(bytes, lookalike.blobs)).toBeUndefined();
  });

  it("is what does not fit, for a body whose data does not fit its schema", async () => {
    const misfit = objectFormat.encode(new ObjectValue(markdownBodySchema.link, { text: 7 }));
    const expectedReading = {
      kind: "unread",
      error: new Error("the data does not fit its schema: #/text: not a string"),
    };
    expect(await readingAt(misfit, markdownBodySchema.blobs)).toEqual(expectedReading);
    expect(await readingAt(misfit)).toEqual(expectedReading);
  });

  it("is nothing for bytes that are not an object, and for a link with no blob", async () => {
    expect(await readingAt(Uint8Array.of(0, 10, 255))).toBeUndefined();
    expect(await readingOf(await inspect(body.link, readerOf([])), readerOf([]))).toBeUndefined();
  });
});
