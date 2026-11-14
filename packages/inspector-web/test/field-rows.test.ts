import { inspect } from "@estoc/inspector";
import {
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  type Reader,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { any, array, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { fieldRowsOf, type Place } from "../src/field-rows.ts";

const noteSchema = schema("Note", {
  text: string(),
  replies: array(link()),
  more: optional(any()),
  at: optional(integer()),
});
const photo = new LinkValue(linkOf(new TextEncoder().encode("a photo")));

function readerOf(...blobs: readonly Uint8Array[]): Reader {
  return new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
}

async function rowsOf(data: ValueMap, schemaLink: Link<unknown> = noteSchema.link, ...others: readonly Uint8Array[]) {
  const bytes = objectFormat.encode(new ObjectValue(schemaLink, data));
  const inspection = await inspect(linkOf(bytes), readerOf(bytes, ...noteSchema.blobs, ...others));
  if (inspection.kind !== "object") throw new Error(`read as ${inspection.kind}`);
  return { rows: fieldRowsOf(inspection), schema: inspection.schema };
}

const place = (value: Value | undefined, problems: readonly string[] = [], parts: Place["parts"] = []): Place => ({
  value,
  problems,
  parts,
});

function* placesIn({ problems, parts }: Place): Generator<readonly string[]> {
  yield problems;
  for (const part of parts) yield* placesIn(part.place);
}

describe("the rows of an object", () => {
  it("are the members of its data as the data orders them, each with its field of the schema", async () => {
    const { rows } = await rowsOf({ text: "a note", replies: [], at: 7 });
    expect(rows.slice(0, 3)).toEqual([
      { name: "at", field: { type: "integer", optional: true }, place: place(7) },
      { name: "text", field: { type: "string" }, place: place("a note") },
      { name: "replies", field: { type: "array", items: { type: "link" } }, place: place([]) },
    ]);
  });

  it("end with the fields that the data leaves out as the schema orders them, an optional one with no problem", async () => {
    const { rows } = await rowsOf({ replies: [] });
    expect(rows.slice(1)).toEqual([
      { name: "at", field: { type: "integer", optional: true }, place: place(undefined) },
      { name: "more", field: { type: "any", optional: true }, place: place(undefined) },
      { name: "text", field: { type: "string" }, place: place(undefined, ["left out"]) },
    ]);
  });

  it("give a member that the schema does not name with no field, and say so", async () => {
    const { rows } = await rowsOf({ text: "a note", replies: [], title: "Hello" });
    expect(rows.find((row) => row.name === "title")).toEqual({
      name: "title",
      field: undefined,
      place: place("Hello", ["not a field of the schema"]),
    });
  });

  it("give the problem of a value where the value is: at the item of an array, and not at the array", async () => {
    const { rows } = await rowsOf({ text: 7, replies: [photo, "a reply"] });
    expect(rows.map((row) => row.place).slice(0, 2)).toEqual([
      place(7, ["not a string"]),
      place(
        [photo, "a reply"],
        [],
        [
          { key: "0", place: place(photo) },
          { key: "1", place: place("a reply", ["not a link"]) },
        ],
      ),
    ]);
  });

  it("give the members of a map by name, and what they hold in turn", async () => {
    const { rows } = await rowsOf({ text: "a note", replies: [], more: { files: [{ photo }] } });
    expect(rows.find((row) => row.name === "more")?.place.parts).toEqual([
      {
        key: "files",
        place: place(
          [{ photo }],
          [],
          [{ key: "0", place: place({ photo }, [], [{ key: "photo", place: place(photo) }]) }],
        ),
      },
    ]);
  });

  it("hold each problem of the validator at one place", async () => {
    const { rows, schema } = await rowsOf({ replies: [photo, "a reply", 7], title: "Hello", at: "now" });
    if (schema.kind !== "schema") throw new Error(`the schema is ${schema.kind}`);
    const held = rows.flatMap((row) => Array.from(placesIn(row.place)).flat());
    expect(schema.problems).toHaveLength(5);
    expect(held).toHaveLength(5);
  });

  it("are the members of its data alone when the reader has no blob for its schema", async () => {
    const { rows } = await rowsOf({ text: 7, title: "Hello" }, photo.link);
    expect(rows).toEqual([
      { name: "text", field: undefined, place: place(7) },
      { name: "title", field: undefined, place: place("Hello") },
    ]);
  });

  it("are the members of its data alone when what it names as its schema is not one", async () => {
    const notSchema = objectFormat.encode(new ObjectValue(noteSchema.link, { text: "a note", replies: [] }));
    const { rows, schema } = await rowsOf({ text: 7 }, linkOf(notSchema), notSchema);
    expect(schema.kind).toBe("refused");
    expect(rows).toEqual([{ name: "text", field: undefined, place: place(7) }]);
  });
});
