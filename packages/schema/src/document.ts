import { isValueMap, objectFormat, type SchemaLanguage, type Value, type ValueMap } from "@estoc/object";

const types = ["array", "link", "bytes", "integer", "string", "boolean", "any"] as const;

type Type =
  | { readonly type: Exclude<(typeof types)[number], "array"> }
  | { readonly type: "array"; readonly items: Item };

/** What an array holds: a type, which is not optional, since an array has no place left empty. */
export type Item = Type & { readonly optional?: never };

/** A field of a schema: the type of its values, and whether an object may leave it out. */
export type Field = Type & { readonly optional?: true };

/**
 * What a schema holds: a `title`, and the `fields` of the objects written to
 * it, each by name.
 *
 * - The title sets apart two schemas of the same fields, and says nothing a validator checks.
 * - An object written to the schema holds the fields listed and no other, and may leave out
 *   only those marked `optional`.
 */
export type SchemaDocument = {
  readonly title: string;
  readonly fields: { readonly [name: string]: Field };
};

/**
 * Estoc Schema, the language of schemas over the object format.
 *
 * - A schema is the object of its document, a `title` and `fields`, written to the root schema.
 * - The root schema is a schema of the language like any other, written to itself. It says that a
 *   schema holds a `title`, a string, and `fields`, of any value.
 * - What `fields` may hold is more than a schema of the language can say, so it is checked here:
 *   each field is a map of the members the language names, its `type` one of the seven, with
 *   `items` in an array alone, and `optional` either `true` or left out.
 * - A document has one spelling, as the encoding orders the members. So the same title and fields
 *   are the same blob.
 */
export const schemaLanguage: SchemaLanguage<Value, SchemaDocument> = {
  encoding: objectFormat,
  root: { title: "Schema", fields: { title: { type: "string" }, fields: { type: "any" } } },
  data: (document) => document,
  document(data) {
    const { title, fields, ...rest } = data;
    refuseMembers(rest, "a schema holds a title and fields alone");
    if (typeof title !== "string") throw new Error("a schema holds a title, a string");
    if (fields === undefined || !isValueMap(fields)) throw new Error("a schema holds fields, each by name");
    for (const [name, field] of Object.entries(fields)) validateField(field, `the field ${name}`);
    return data as SchemaDocument;
  },
};

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
