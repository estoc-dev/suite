import type { Body } from "@estoc/blog";
import type { NamedSchema } from "@estoc/inspector";
import { isValueMap, LinkValue, type Value } from "@estoc/object";
import { type Child, h, markup, mono, muted } from "./dom.ts";
import { type FieldRow, type FieldTable, fieldTableOf, type InspectedObject, type Place } from "./field-table.ts";
import { linkView } from "./link-view.ts";
import type { Reading } from "./reading.ts";
import { hexOf, messageOf, sizeOf, typeNameOf } from "./text.ts";

const quantityOf = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function valueView(value: Value, partCount: number): HTMLElement {
  if (typeof value === "string") return mono(JSON.stringify(value), "string");
  if (value instanceof Uint8Array) return h("span", null, muted(`${sizeOf(value)} `), mono(hexOf(value), "bytes"));
  if (value instanceof LinkValue) return linkView(value.link);
  if (Array.isArray(value)) return muted(`array · ${quantityOf(partCount, "item", "items")}`);
  if (isValueMap(value)) return muted(`map · ${quantityOf(partCount, "member", "members")}`);
  return mono(String(value));
}

// The problems of an array or a map come before what it holds, so that they are not read as those of its last part.
function placeView({ value, problems, parts }: Place, key?: string): HTMLElement {
  const content = value === undefined ? problems.length === 0 && muted("left out") : valueView(value, parts.length);
  return h(
    "div",
    { class: key === undefined ? "place" : "place part" },
    content && h("div", { class: "line" }, key !== undefined && mono(key, "key"), content),
    problems.map((problem) => h("p", { class: "problem" }, problem)),
    parts.map((part) => placeView(part.place, part.key)),
  );
}

function typeCell({ field }: FieldRow): HTMLElement {
  if (field === undefined) return h("td");
  return h("td", null, mono(typeNameOf(field)), field.optional === true && muted(" · optional"));
}

function fieldTableView({ rows }: FieldTable, isTyped: boolean): HTMLElement {
  if (rows.length === 0) return h("p", { class: "note" }, "The object has no fields.");
  return h(
    "table",
    null,
    h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Value"), isTyped && h("th", null, "Type"))),
    h(
      "tbody",
      null,
      rows.map((row) =>
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
function schemaView(schema: NamedSchema, object: InspectedObject, { unplacedProblems }: FieldTable): Child[] {
  const link = linkView(schema.link);
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
      length === 0 ? "The data fits it." : `The data does not fit it: ${quantityOf(length, "problem", "problems")}.`,
    ),
    unplacedProblems.length > 0 && [
      h("p", { class: "note" }, "Not marked in the table, since each reads as a problem of more than one value:"),
      unplacedProblems.map((problem) => h("p", { class: "mono problem" }, problem)),
    ],
  ];
}

const bodyView = ({ html }: Body) => markup("div", { class: "rendered" }, html);

// What the page reads the object as stands above its fields and does not take their place: the
// fields are what the blob says of itself.
function readingView(reading: Reading): HTMLElement {
  return h(
    "div",
    { class: "reading" },
    reading.kind === "read"
      ? [h("p", { class: "band" }, "Read by this page as the body of a post"), bodyView(reading.body)]
      : [
          h("p", { class: "band" }, "Not read by this page as the body of a post"),
          h("p", { class: "problem" }, messageOf(reading.error)),
        ],
  );
}

export function objectView(object: InspectedObject, reading?: Reading): HTMLElement {
  const table = fieldTableOf(object);
  return h(
    "section",
    { class: "card" },
    h(
      "dl",
      { class: "head" },
      h("dt", null, "Link"),
      h("dd", null, mono(object.link)),
      h("dt", null, "Size"),
      h("dd", null, sizeOf(object.bytes)),
      h("dt", null, "Schema"),
      h("dd", null, schemaView(object.schema, object, table)),
    ),
    reading !== undefined && readingView(reading),
    fieldTableView(table, object.schema.kind === "schema"),
  );
}
