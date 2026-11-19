import type { Inspection } from "@estoc/inspector";
import { isValueMap, type Value } from "@estoc/object";
import type { Field } from "@estoc/schema";

export type InspectedObject = Extract<Inspection, { readonly kind: "object" }>;

export interface Place {
  readonly value: Value | undefined;
  readonly problems: readonly string[];
  readonly parts: readonly Part[];
}

export interface Part {
  readonly key: string;
  readonly place: Place;
}

export interface FieldRow {
  readonly name: string;
  readonly field: Field | undefined;
  readonly place: Place;
}

export interface FieldTable {
  readonly rows: readonly FieldRow[];
  readonly unplacedProblems: readonly string[];
}

/**
 * The validator names a place as text, and a name that holds `/` or `: ` can spell the place of
 * another value as well as its own, so a problem that reads as that of more than one place is held
 * at none of them.
 */
export function fieldTableOf({ data, schema }: InspectedObject): FieldTable {
  const fields = schema.kind === "schema" ? schema.document.fields : {};
  const problemsAt = new Map<string, string[][]>();
  const placeAt = (path: string, value: Value | undefined): Place => {
    const problems: string[] = [];
    const problemLists = problemsAt.get(path);
    if (problemLists === undefined) problemsAt.set(path, [problems]);
    else problemLists.push(problems);
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

function* readingsOf(problem: string): Generator<{ readonly path: string; readonly message: string }> {
  for (let end = problem.indexOf(": "); end !== -1; end = problem.indexOf(": ", end + 1))
    yield { path: problem.slice(0, end), message: problem.slice(end + 2) };
}

function partsOf(value: Value | undefined): (readonly [string, Value])[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return (value as readonly Value[]).map((item, index) => [String(index), item]);
  return isValueMap(value) ? Object.entries(value) : [];
}
