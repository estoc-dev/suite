import type { NamedSchema } from "@estoc/inspector";
import { isValueMap, LinkValue, type Value } from "@estoc/object";
import { type Child, h, mono, muted } from "./dom.ts";
import { type FieldRow, fieldRowsOf, type InspectedObject, type Place } from "./field-rows.ts";
import { hexOf, messageOf, sizeOf, typeNameOf } from "./text.ts";

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function shownValue(value: Value, partCount: number): HTMLElement {
  if (typeof value === "string") return mono(JSON.stringify(value), "string");
  if (value instanceof Uint8Array) return h("span", null, muted(`${sizeOf(value)} `), mono(hexOf(value), "bytes"));
  if (value instanceof LinkValue) return mono(value.link, "link");
  if (Array.isArray(value)) return muted(`array · ${counted(partCount, "item", "items")}`);
  if (isValueMap(value)) return muted(`map · ${counted(partCount, "member", "members")}`);
  return mono(String(value));
}

// The problems of an array or a map come before what it holds, so that they are not read as those of its last part.
function placeView({ value, problems, parts }: Place, key?: string): HTMLElement {
  const shown = value === undefined ? problems.length === 0 && muted("left out") : shownValue(value, parts.length);
  return h(
    "div",
    { class: key === undefined ? "place" : "place part" },
    shown && h("div", { class: "line" }, key !== undefined && mono(key, "key"), shown),
    ...problems.map((problem) => h("p", { class: "problem" }, problem)),
    ...parts.map((part) => placeView(part.place, part.key)),
  );
}

function typeCell({ field }: FieldRow): HTMLElement {
  if (field === undefined) return h("td");
  return h("td", null, mono(typeNameOf(field)), field.optional === true && muted(" · optional"));
}

function fieldTable(object: InspectedObject): HTMLElement {
  const rows = fieldRowsOf(object);
  if (rows.length === 0) return h("p", { class: "note" }, "The object has no fields.");
  const isTyped = object.schema.kind === "schema";
  return h(
    "table",
    null,
    h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Value"), isTyped && h("th", null, "Type"))),
    h(
      "tbody",
      null,
      ...rows.map((row) =>
        h(
          "tr",
          null,
          h("td", null, mono(row.name, "name")),
          h("td", null, placeView(row.place)),
          isTyped && typeCell(row),
        ),
      ),
    ),
  );
}

// A title is the one the schema gave itself, so it is shown beside the link of the schema, which
// is what tells one schema from another of the same title.
function schemaView(schema: NamedSchema, object: InspectedObject): Child[] {
  const link = mono(schema.link, "link");
  if (schema.kind === "absent") return [link, h("p", { class: "note" }, "No blob is given for it.")];
  if (schema.kind === "refused")
    return [link, h("p", { class: "problem" }, `Not a schema of Estoc Schema: ${messageOf(schema.error)}`)];
  const { length } = schema.problems;
  return [
    h("span", { class: "title" }, schema.document.title),
    " ",
    link,
    h(
      "p",
      { class: length === 0 ? "note" : "problem" },
      schema.link === object.link ? "The object is written to itself. " : false,
      length === 0 ? "The data fits it." : `The data does not fit it: ${counted(length, "problem", "problems")}.`,
    ),
  ];
}

export function objectView(object: InspectedObject): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h(
      "dl",
      { class: "head" },
      h("dt", null, "Link"),
      h("dd", null, mono(object.link, "link")),
      h("dt", null, "Size"),
      h("dd", null, sizeOf(object.bytes)),
      h("dt", null, "Schema"),
      h("dd", null, ...schemaView(object.schema, object)),
    ),
    fieldTable(object),
  );
}
