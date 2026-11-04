import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  DRAFT_2020_12,
  decodeObject,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type LineageData,
  lineageOf,
  lineageSchema,
  type Schema,
} from "../src/index.ts";

const lineages: Schema<Json, LineageData<Schema<Json>>> = await encodeSchema(lineageSchema, defaultValidator);
const versionTitled = (title: string) => encodeSchema({ $schema: DRAFT_2020_12, title }, defaultValidator);
const first = await versionTitled("first");
const second = await versionTitled("second");

describe("lineageOf", () => {
  it("gives the versions a lineage lists, oldest first", () => {
    const object = encodeObject(lineages, { versions: [{ $link: first.link }, { $link: second.link }] });
    expect(lineageOf(object)).toEqual({ link: object.link, versions: [first.link, second.link] });
  });
});

describe("lineageSchema", () => {
  it.each([
    ["no versions", []],
    ["a version twice", [{ $link: first.link }, { $link: first.link }]],
    ["a version that is not a link", [{ link: first.link }]],
  ])("refuses a lineage of %s", (_, versions) => {
    expect(() => decodeObject(json.encode(json.object({ versions }, lineages.link)), lineages)).toThrow(
      "the data does not fit its schema",
    );
  });
});
