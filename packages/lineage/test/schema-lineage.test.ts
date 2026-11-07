import {
  encodeObject,
  encodeSchema,
  type Implementation,
  type Json,
  type Link,
  linkOf,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, expectTypeOf, it } from "vitest";
import { loadLineage } from "../src/index.ts";

// A format of notes whose second version gives a note a title.

interface Note {
  readonly title?: string;
  readonly text: string;
}

type NoteV1Data = { readonly text: string };
type NoteV2Data = { readonly title: string; readonly body: string };

const lineages = await loadLineage(defaultValidator);
const noteV1: Schema<Json, NoteV1Data> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Note",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);
const noteV2: Schema<Json, NoteV2Data> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Note",
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
    additionalProperties: false,
  },
  defaultValidator,
);
const other = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);

const v1: Implementation<Json, Note, NoteV1Data> = { schema: noteV1, read: ({ data }) => ({ text: data.text }) };
const v2: Implementation<Json, Note, NoteV2Data> = {
  schema: noteV2,
  read: ({ data }) => ({ title: data.title, text: data.body }),
};
const notes = lineages.schemaLineageOf([v1, v2]);

const untitled = encodeObject(noteV1, { text: "hello" });
const titled = encodeObject(noteV2, { title: "Greeting", body: "hello" });
const noteAt = ({ link }: { readonly link: Link<unknown> }) => link as Link<Note>;
const byLink = (blobs: readonly Uint8Array[]) =>
  new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));

describe("the schema lineage of versions", () => {
  it("is the lineage of their schemas, in their order", () => {
    expect(notes.lineage.items).toEqual([noteV1.link, noteV2.link]);
  });

  it("starts with the first node of the series of the first version's schema", () => {
    expect(notes.lineage.first.link).toBe(lineages.startingWith(noteV1).first.link);
  });

  it("has the head of every schema lineage of the same versions in the same order", () => {
    expect(lineages.schemaLineageOf([v1, v2]).lineage.head.link).toBe(notes.lineage.head.link);
    expect(lineages.schemaLineageOf([v2, v1]).lineage.head.link).not.toBe(notes.lineage.head.link);
  });

  it("holds the closure of its head in its blobs", async () => {
    const blobs = byLink(notes.blobs);
    expect((await lineages.read(notes.lineage.head.link, blobs)).items).toEqual(notes.lineage.items);
    for (const link of [noteV1.link, noteV2.link, defaultValidator.language.link]) expect(blobs.has(link)).toBe(true);
  });

  it("refuses two versions of one schema", () => {
    expect(() => lineages.schemaLineageOf([v1, v2, { ...v1 }])).toThrow(`${noteV1.link} is given two implementations`);
  });
});

describe("reading with a schema lineage", () => {
  it("reads an object of each version with that version", async () => {
    const reader = byLink([untitled.bytes, titled.bytes]);
    await expect(notes.read(noteAt(untitled), reader)).resolves.toEqual({ text: "hello" });
    await expect(notes.read(noteAt(titled), reader)).resolves.toEqual({ title: "Greeting", text: "hello" });
  });

  it("reads as the shape its versions give, with no type named for it", () => {
    expectTypeOf(notes.read).returns.toEqualTypeOf<Promise<Note>>();
  });

  it("refuses an object of the schema of no version", async () => {
    const object = encodeObject(other, { text: "hello" });
    await expect(notes.read(noteAt(object), byLink([object.bytes]))).rejects.toThrow(
      `${other.link} is not a schema read here`,
    );
  });
});
