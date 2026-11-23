import type { NamedSchema } from "@estoc/inspector";
import { LinkValue, type Value } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { type FieldRow, type FieldTable, fieldTableOf, type InspectedObject, type Slot } from "./field-table.ts";
import type { Reading } from "./reading.ts";
import { messageOf, quantityOf, typeNameOf } from "./text.ts";
import { linkView, valueView } from "./value-view.tsx";

// A value has a line to itself here, so a string is shown with its quotes and what an array or a
// map holds is shown under it.
function heldView(value: Value, partCount: number): JSX.Element {
  if (typeof value === "string") return <span class="mono string">{JSON.stringify(value)}</span>;
  if (value instanceof LinkValue) return linkView(value.link);
  if (Array.isArray(value)) return <span class="muted">array · {quantityOf(partCount, "item", "items")}</span>;
  return valueView(value);
}

// The problems of an array or a map come before what it holds, so that they are not read as those of its last part.
function slotView({ value, problems, parts }: Slot, key?: string): JSX.Element {
  return (
    <div class={key === undefined ? "slot" : "slot part"}>
      {(value !== undefined || problems.length === 0) && (
        <div class="line">
          {key !== undefined && <span class="mono key">{key}</span>}
          {value === undefined ? <span class="muted">left out</span> : heldView(value, parts.length)}
        </div>
      )}
      {problems.map((problem) => (
        <p class="problem">{problem}</p>
      ))}
      {parts.map((part) => slotView(part.slot, part.key))}
    </div>
  );
}

function typeCell({ field }: FieldRow): JSX.Element {
  return (
    <td>
      {field !== undefined && <span class="mono">{typeNameOf(field)}</span>}
      {field?.optional === true && <span class="muted"> · optional</span>}
    </td>
  );
}

function fieldTableView({ rows }: FieldTable, isTyped: boolean): JSX.Element {
  if (rows.length === 0) return <p class="note">The object has no fields.</p>;
  return (
    <table class="fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          {isTyped && <th>Type</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td>
              <span class="mono name">{row.name}</span>
            </td>
            <td>{slotView(row.slot)}</td>
            {isTyped && typeCell(row)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A title is the one the schema gave itself, so it is shown beside the link of the schema, which
// is what tells one schema from another of the same title.
function schemaView(schema: NamedSchema, object: InspectedObject, { unplacedProblems }: FieldTable): JSX.Element {
  if (schema.kind === "absent")
    return (
      <>
        {linkView(schema.link)}
        <p class="note">The runtime gives no blob for it.</p>
      </>
    );
  if (schema.kind === "refused")
    return (
      <>
        {linkView(schema.link)}
        <p class="problem">Not a schema of Estoc Schema: {messageOf(schema.error)}</p>
      </>
    );
  const { length } = schema.problems;
  return (
    <>
      <span class="title">{schema.document.title}</span> {linkView(schema.link)}
      <p class={length === 0 ? "note" : "problem"}>
        {schema.link === object.link && "The object is written to itself. "}
        {length === 0 ? "The data fits it." : `The data does not fit it: ${quantityOf(length, "problem", "problems")}.`}
      </p>
      {unplacedProblems.length > 0 && (
        <>
          <p class="note">Not marked in the table, since each reads as a problem of more than one value:</p>
          {unplacedProblems.map((problem) => (
            <p class="mono problem">{problem}</p>
          ))}
        </>
      )}
    </>
  );
}

// What the page reads the object as stands above its fields and does not take their place: the
// fields are what the blob says of itself.
function readingView(reading: Reading): JSX.Element {
  return (
    <div class="reading">
      {reading.kind === "read" ? (
        <>
          <p class="band">Read by this page as {reading.as.name}</p>
          {reading.as.viewOf(reading.value)}
        </>
      ) : (
        <>
          <p class="band">Not read by this page as {reading.as.name}</p>
          <p class="problem">{messageOf(reading.error)}</p>
        </>
      )}
    </div>
  );
}

export function objectView(object: InspectedObject, reading: Reading | undefined): JSX.Element {
  const table = fieldTableOf(object);
  return (
    <>
      <dl class="head">
        <dt>Link</dt>
        <dd class="mono">{object.link}</dd>
        <dt>Size</dt>
        <dd>{quantityOf(object.bytes.length, "byte", "bytes")}</dd>
        <dt>Schema</dt>
        <dd>{schemaView(object.schema, object, table)}</dd>
      </dl>
      {reading !== undefined && readingView(reading)}
      {fieldTableView(table, object.schema.kind === "schema")}
    </>
  );
}
