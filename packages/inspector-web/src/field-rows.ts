import type { Inspection } from "@estoc/inspector";
import { isValueMap, type Value } from "@estoc/object";
import type { Field } from "@estoc/schema";

export type InspectedObject = Extract<Inspection, { readonly kind: "object" }>;

/** A place in the data of an object: what is there, and what the validator of its schema says of it. */
export interface Place {
  /** Nothing where the data leaves out a field of the schema. */
  readonly value: Value | undefined;
  readonly problems: readonly string[];
  /** The items of an array by index and the members of a map by name, as the data orders them. */
  readonly parts: readonly Part[];
}

export interface Part {
  readonly key: string;
  readonly place: Place;
}

export interface FieldRow {
  readonly name: string;
  /** What the schema says of the field. Nothing when it has no such field, or could not be read. */
  readonly field: Field | undefined;
  readonly place: Place;
}

/**
 * The rows of the field table of an object: the members of its data as the data orders them, then
 * the fields of its schema that the data leaves out, as the schema orders them.
 *
 * A problem is held at the place that the validator names, matched by how the validator spells
 * the place. A name that holds `/` or `: ` can spell the place of another value, and is then given
 * that value's problem as well.
 */
export function fieldRowsOf({ data, schema }: InspectedObject): FieldRow[] {
  const fields = schema.kind === "schema" ? schema.document.fields : {};
  const problems = schema.kind === "schema" ? schema.problems : [];
  const rowOf = (name: string, value: Value | undefined): FieldRow => ({
    name,
    field: Object.hasOwn(fields, name) ? fields[name] : undefined,
    place: placeAt(`#/${name}`, value, problems),
  });
  return [
    ...Object.entries(data).map(([name, value]) => rowOf(name, value)),
    ...Object.keys(fields)
      .filter((name) => !Object.hasOwn(data, name))
      .map((name) => rowOf(name, undefined)),
  ];
}

function placeAt(path: string, value: Value | undefined, problems: readonly string[]): Place {
  const start = `${path}: `;
  return {
    value,
    problems: problems.filter((problem) => problem.startsWith(start)).map((problem) => problem.slice(start.length)),
    parts: partsOf(value).map(([key, part]) => ({ key, place: placeAt(`${path}/${key}`, part, problems) })),
  };
}

function partsOf(value: Value | undefined): (readonly [string, Value])[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return (value as readonly Value[]).map((item, index) => [String(index), item]);
  return isValueMap(value) ? Object.entries(value) : [];
}
