import { encodeObject, type Implementation, type Json, json, type Link, linkOf } from "@estoc/object";
import { type DataOf, schema, schemaRoot, string } from "@estoc/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import { lineages, SelectionBySchemaLineage } from "../src/index.ts";

interface Note {
  readonly title?: string;
  readonly text: string;
}

const noteV1 = await schema("Note", { text: string() });
const noteV2 = await schema("Note", { title: string(), body: string() });
const other = await schema("Other", { text: string() });

const v1: Implementation<Json, Note, DataOf<typeof noteV1>> = {
  schema: noteV1,
  read: ({ data }) => ({ text: data.text }),
};
const v2: Implementation<Json, Note, DataOf<typeof noteV2>> = {
  schema: noteV2,
  read: ({ data }) => ({ title: data.title, text: data.body }),
};
const notes = lineages.schemaLineageOf([v1, v2]);

const untitledNote = encodeObject(noteV1, { text: "hello" });
const titledNote = encodeObject(noteV2, { title: "Greeting", body: "hello" });
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
    for (const link of [noteV1.link, noteV2.link, schemaRoot.link]) expect(blobs.has(link)).toBe(true);
  });

  it("has the schema that an object of a version names, and no other", () => {
    expect(notes.hasSchemaNamedBy(untitledNote.bytes)).toBe(true);
    expect(notes.hasSchemaNamedBy(titledNote.bytes)).toBe(true);
    expect(notes.hasSchemaNamedBy(encodeObject(other, { text: "hello" }).bytes)).toBe(false);
  });

  it("refuses two versions of one schema", () => {
    expect(() => lineages.schemaLineageOf([v1, v2, { ...v1 }])).toThrow(`${noteV1.link} is given two implementations`);
  });
});

describe("reading with a schema lineage", () => {
  it("reads an object of each version with that version", async () => {
    const reader = byLink([untitledNote.bytes, titledNote.bytes]);
    await expect(notes.read(noteAt(untitledNote), reader)).resolves.toEqual({ text: "hello" });
    await expect(notes.read(noteAt(titledNote), reader)).resolves.toEqual({ title: "Greeting", text: "hello" });
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

describe("the selection of a schema lineage", () => {
  it("takes an object of each version, read as that version reads it", async () => {
    const reader = byLink([untitledNote.bytes, titledNote.bytes]);
    await expect(notes.selection.read(untitledNote.link, reader)).resolves.toEqual({ text: "hello" });
    await expect(notes.selection.read(titledNote.link, reader)).resolves.toEqual({ title: "Greeting", text: "hello" });
  });
});

describe("a selection by schema lineage", () => {
  const titles = new SelectionBySchemaLineage(notes, ({ title }) => title);

  it("takes a record of a version as what itemOf gives of it", async () => {
    await expect(titles.read(titledNote.link, byLink([titledNote.bytes]))).resolves.toBe("Greeting");
  });

  it("leaves out a record that itemOf leaves out", async () => {
    await expect(titles.read(untitledNote.link, byLink([untitledNote.bytes]))).resolves.toBeUndefined();
  });

  it("leaves out a record of the schema of no version", async () => {
    const object = encodeObject(other, { text: "hello" });
    await expect(titles.read(object.link, byLink([object.bytes]))).resolves.toBeUndefined();
  });

  it("refuses a record of a version whose data does not fit its schema", async () => {
    const bytes = json.encode(json.object({ body: "hello" }, noteV1.link));
    await expect(titles.read(linkOf(bytes), byLink([bytes]))).rejects.toThrow("the data does not fit its schema");
  });

  it("refuses a record the reader does not give", async () => {
    await expect(titles.read(titledNote.link, byLink([]))).rejects.toThrow(`no blob is given for ${titledNote.link}`);
  });
});
