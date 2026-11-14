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

export interface FieldTable {
  readonly rows: readonly FieldRow[];
  /** The problems that no row holds, as the validator words them. */
  readonly unplacedProblems: readonly string[];
}

/**
 * The field table of an object.
 *
 * - The rows are the members of the data as the data orders them, then the fields of the schema
 *   that the data leaves out, as the schema orders them.
 * - A problem is held at the place the validator names. The validator names a place as text, and
 *   a name that holds `/` or `: ` can spell the place of another value as well as its own.
 * - A problem that reads as that of more than one place is held at none of them, and is left
 *   unplaced.
 */
export function fieldTableOf({ data, schema }: InspectedObject): FieldTable {
  const fields = schema.kind === "schema" ? schema.document.fields : {};
  const problemsAt = new Map<string, string[][]>();
  const placeAt = (path: string, value: Value | undefined): Place => {
    const problems: string[] = [];
    const spelledAlike = problemsAt.get(path);
    if (spelledAlike === undefined) problemsAt.set(path, [problems]);
    else spelledAlike.push(problems);
    return {
      value,
      problems,
      parts: partsOf(value).map(([key, part]) => ({ key, place: placeAt(`${path}/${key}`, part) })),
    };
  };
  const rowOf = (name: string, value: Value | undefined): FieldRow => ({
    name,
    field: Object.hasOwn(fields, name) ? fields[name] : undefined,
    place: placeAt(`#/${name}`, value),
  });
  const rows = [
    ...Object.entries(data).map(([name, value]) => rowOf(name, value)),
    ...Object.keys(fields)
      .filter((name) => !Object.hasOwn(data, name))
      .map((name) => rowOf(name, undefined)),
  ];

  const unplacedProblems: string[] = [];
  for (const problem of schema.kind === "schema" ? schema.problems : []) {
    const [reading, ...others] = Array.from(readingsOf(problem)).flatMap(({ path, message }) =>
      (problemsAt.get(path) ?? []).map((problems) => ({ problems, message })),
    );
    if (reading !== undefined && others.length === 0) reading.problems.push(reading.message);
    else unplacedProblems.push(problem);
  }
  return { rows, unplacedProblems };
}

/** The ways to read a problem as a place and what is said of it: one for each `: ` it holds. */
function* readingsOf(problem: string): Generator<{ readonly path: string; readonly message: string }> {
  for (let end = problem.indexOf(": "); end !== -1; end = problem.indexOf(": ", end + 1))
    yield { path: problem.slice(0, end), message: problem.slice(end + 2) };
}

function partsOf(value: Value | undefined): (readonly [string, Value])[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return (value as readonly Value[]).map((item, index) => [String(index), item]);
  return isValueMap(value) ? Object.entries(value) : [];
}
