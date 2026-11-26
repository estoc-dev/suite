import { isValueMap, LinkValue, memberOf, type Value, type ValueMap } from "./object-format.ts";

const types = ["array", "link", "bytes", "integer", "string", "boolean", "any"] as const;

type Type =
  | { readonly type: Exclude<(typeof types)[number], "array"> }
  | { readonly type: "array"; readonly items: Item };

/** Not optional, since an array has no place left empty. */
export type Item = Type & { readonly optional?: never };

export type Field = Type & { readonly optional?: true };

/** The title sets apart two schemas of the same fields, and no data is checked against it. */
export type SchemaDocument = {
  readonly title: string;
  readonly fields: { readonly [name: string]: Field };
};

export const rootDocument: SchemaDocument = {
  title: "Schema",
  fields: { title: { type: "string" }, fields: { type: "any" } },
};

/** What the root schema says a schema holds. */
export type RootData = { readonly title: string; readonly fields: Value };

/**
 * - What `fields` may hold is more than the root schema can say, so it is checked here.
 * - A field says its type and whether it is optional, and nothing more: bounds, lengths and fixed
 *   values are for the program that reads the object to check.
 * - No place in a document takes a link, so the closure of a schema is the schema and its root
 *   schema.
 */
export function documentOf({ title, fields }: RootData): SchemaDocument {
  if (!isValueMap(fields)) throw new Error("a schema holds fields, each by name");
  for (const [name, field] of Object.entries(fields)) validateField(field, `the field ${name}`);
  return { title, fields: fields as SchemaDocument["fields"] };
}

function validateField(field: Value, place: string): void {
  const { optional, ...type } = membersOf(field, place);
  if (optional !== undefined && optional !== true)
    throw new Error(`${place} is marked optional with true, or not marked`);
  validateType(type, place);
}

function validateType(value: Value, place: string): void {
  const { type, items, ...rest } = membersOf(value, place);
  refuseMembers(rest, `${place} holds a type, and items when it is an array`);
  if (!types.includes(type as (typeof types)[number]))
    throw new Error(`the type of ${place} is one of ${types.join(", ")}`);
  if (type === "array") {
    if (items === undefined) throw new Error(`${place} is an array, and says what its items are`);
    validateType(items, `the items of ${place}`);
  } else if (items !== undefined) {
    throw new Error(`${place} is not an array, and has no items`);
  }
}

function membersOf(value: Value, place: string): ValueMap {
  if (!isValueMap(value)) throw new Error(`${place} is a map`);
  return value;
}

function refuseMembers(members: ValueMap, rule: string): void {
  const names = Object.keys(members);
  if (names.length > 0) throw new Error(`${rule}, not ${names.join(", ")}`);
}

const fits: { readonly [T in Item["type"]]: (value: Value) => boolean } = {
  array: Array.isArray,
  link: (value) => value instanceof LinkValue,
  bytes: (value) => value instanceof Uint8Array,
  integer: Number.isSafeInteger,
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
  any: () => true,
};

const mismatch: { readonly [T in Item["type"]]: string } = {
  array: "not an array",
  link: "not a link",
  bytes: "not bytes",
  integer: "not an integer of at most 2^53 - 1 either way",
  string: "not a string",
  boolean: "not a boolean",
  any: "not a value",
};

function* problemsAt(value: Value, type: Field | Item, path: string): Generator<string> {
  if (!fits[type.type](value)) yield `${path}: ${mismatch[type.type]}`;
  else if (type.type === "array")
    for (const [index, item] of (value as readonly Value[]).entries())
      yield* problemsAt(item, type.items, `${path}/${index}`);
}

/**
 * What fits is answered from the document and the data alone, so the link of a schema fixes all that
 * its data is checked against.
 */
export function problemsOf(data: ValueMap, { fields }: SchemaDocument): string[] {
  const problems = Object.keys(data)
    .filter((name) => !Object.hasOwn(fields, name))
    .map((name) => `#/${name}: not a field of the schema`);
  for (const [name, field] of Object.entries(fields)) {
    const value = memberOf(data, name);
    if (value !== undefined) problems.push(...problemsAt(value, field, `#/${name}`));
    else if (field.optional !== true) problems.push(`#/${name}: left out`);
  }
  return problems;
}
