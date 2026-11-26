import { type Link, LinkValue, linkOf, ObjectValue, objectFormat, type Value, type ValueMap } from "@estoc/object";
import { any, array, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { fieldTableOf, inspect, type Slot } from "../src/index.ts";
import { readerOf } from "./fixtures.ts";

const noteSchema = schema("Note", {
  text: string(),
  replies: array(link()),
  more: optional(any()),
  at: optional(integer()),
});
const photo = new LinkValue(linkOf(new TextEncoder().encode("a photo")));

async function tableOf(data: ValueMap, schemaLink: Link<unknown> = noteSchema.link, ...others: readonly Uint8Array[]) {
  const bytes = objectFormat.encode(new ObjectValue(schemaLink, data));
  const inspection = await inspect(linkOf(bytes), readerOf(bytes, ...noteSchema.blobs, ...others));
  if (inspection.kind !== "object") throw new Error(`read as ${inspection.kind}`);
  return { ...fieldTableOf(inspection), schema: inspection.schema };
}

const slot = (value: Value | undefined, problems: readonly string[] = [], parts: Slot["parts"] = []): Slot => ({
  value,
  problems,
  parts,
});

function* problemsAt({ problems, parts }: Slot): Generator<string> {
  yield* problems;
  for (const part of parts) yield* problemsAt(part.slot);
}

const problemsIn = (rows: readonly { readonly slot: Slot }[]) =>
  rows.flatMap((row) => Array.from(problemsAt(row.slot)));

describe("the rows of an object", () => {
  it("are the members of its data as the data orders them, each with its field of the schema", async () => {
    const { rows } = await tableOf({ text: "a note", replies: [], at: 7 });
    expect(rows.slice(0, 3)).toEqual([
      { name: "at", field: { type: "integer", optional: true }, slot: slot(7) },
      { name: "text", field: { type: "string" }, slot: slot("a note") },
      { name: "replies", field: { type: "array", items: { type: "link" } }, slot: slot([]) },
    ]);
  });

  it("end with the fields that the data leaves out as the schema orders them, an optional one with no problem", async () => {
    const { rows } = await tableOf({ replies: [] });
    expect(rows.slice(1)).toEqual([
      { name: "at", field: { type: "integer", optional: true }, slot: slot(undefined) },
      { name: "more", field: { type: "any", optional: true }, slot: slot(undefined) },
      { name: "text", field: { type: "string" }, slot: slot(undefined, ["left out"]) },
    ]);
  });

  it("give a member that the schema does not name with no field, and say so", async () => {
    const { rows } = await tableOf({ text: "a note", replies: [], title: "Hello" });
    expect(rows.find((row) => row.name === "title")).toEqual({
      name: "title",
      field: undefined,
      slot: slot("Hello", ["not a field of the schema"]),
    });
  });

  it("give the problem of a value where the value is: at the item of an array, and not at the array", async () => {
    const { rows } = await tableOf({ text: 7, replies: [photo, "a reply"] });
    expect(rows.map((row) => row.slot).slice(0, 2)).toEqual([
      slot(7, ["not a string"]),
      slot(
        [photo, "a reply"],
        [],
        [
          { key: "0", slot: slot(photo) },
          { key: "1", slot: slot("a reply", ["not a link"]) },
        ],
      ),
    ]);
  });

  it("give the members of a map by name, and what they hold in turn", async () => {
    const { rows } = await tableOf({ text: "a note", replies: [], more: { files: [{ photo }] } });
    expect(rows.find((row) => row.name === "more")?.slot.parts).toEqual([
      {
        key: "files",
        slot: slot([{ photo }], [], [{ key: "0", slot: slot({ photo }, [], [{ key: "photo", slot: slot(photo) }]) }]),
      },
    ]);
  });

  it("hold each problem at one slot", async () => {
    const { rows, unplacedProblems, schema } = await tableOf({
      replies: [photo, "a reply", 7],
      title: "Hello",
      at: "now",
    });
    if (schema.kind !== "schema") throw new Error(`the schema is ${schema.kind}`);
    expect(schema.problems).toHaveLength(5);
    expect(problemsIn(rows)).toHaveLength(5);
    expect(unplacedProblems).toEqual([]);
  });

  it("hold the problem of a field whose name holds `: ` or `/`, when it reads as that of no other slot", async () => {
    const named = schema("Named", { "label: detail": string(), "a/0": string() });
    const { rows, unplacedProblems } = await tableOf({ "label: detail": 8, "a/0": 7 }, named.link, ...named.blobs);
    expect(rows.map((row) => row.slot)).toEqual([slot(7, ["not a string"]), slot(8, ["not a string"])]);
    expect(unplacedProblems).toEqual([]);
  });

  it("hold at no slot a problem that reads as that of more than one, and leave it unplaced", async () => {
    const named = schema("Named", { a: any(), "a/0": string(), label: string(), "label: detail": string() });
    const { rows, unplacedProblems } = await tableOf(
      { a: ["valid nested text"], "a/0": 7, label: "valid field text", "label: detail": 8 },
      named.link,
      ...named.blobs,
    );
    expect(problemsIn(rows)).toEqual([]);
    expect(unplacedProblems).toEqual(["#/a/0: not a string", "#/label: detail: not a string"]);
  });

  it("are the members of its data alone when the reader has no blob for its schema", async () => {
    const { rows } = await tableOf({ text: 7, title: "Hello" }, photo.link);
    expect(rows).toEqual([
      { name: "text", field: undefined, slot: slot(7) },
      { name: "title", field: undefined, slot: slot("Hello") },
    ]);
  });

  it("are the members of its data alone when what it names as its schema is not one", async () => {
    const notSchema = objectFormat.encode(new ObjectValue(noteSchema.link, { text: "a note", replies: [] }));
    const { rows, schema } = await tableOf({ text: 7 }, linkOf(notSchema), notSchema);
    expect(schema.kind).toBe("refused");
    expect(rows).toEqual([{ name: "text", field: undefined, slot: slot(7) }]);
  });
});
