import {
  isJsonObject,
  type Json,
  json,
  type SchemaLanguage,
  type SelfDescribingObject,
  selfDescribingObject,
} from "@estoc/object";

const types = ["array", "link", "bytes", "integer", "string", "boolean"] as const;

type Type =
  | { readonly type: Exclude<(typeof types)[number], "array"> }
  | { readonly type: "array"; readonly items: Item };

/** What an array holds: a type, which is not optional, since an array has no place left empty. */
export type Item = Type & { readonly optional?: never };

/** A field of a schema: the type of its values, and whether an object may leave it out. */
export type Field = Type & { readonly optional?: true };

/**
 * A schema as its data: a `title`, and the `fields` of the objects written
 * to it, each by name.
 *
 * - The title sets apart two schemas of the same fields, as the name of a key scheme does, and
 *   says nothing a validator checks.
 * - An object written to the schema holds the fields listed and no other, and may leave out
 *   only those marked `optional`.
 */
export type SchemaDocument = {
  readonly title: string;
  readonly fields: { readonly [name: string]: Field };
};

export const schemaRoot: SelfDescribingObject<Json> = selfDescribingObject(json, { language: "Estoc Schema" });

/**
 * The language of schemas over JSON whose schemas are written to
 * `schemaRoot`.
 *
 * - The data of a schema is its document as it is, `title` and `fields`. No schema reads a root,
 *   so `document` checks that the data is one.
 * - A document has one spelling: every member is one the language names, `optional` is `true` or
 *   left out, and the encoding orders the members. So the same title and fields are the same
 *   blob.
 * - A field is not named `$schema`, which an object keeps for the schema it is written to.
 */
export const schemaLanguage: SchemaLanguage<Json, SchemaDocument> = {
  encoding: json,
  link: schemaRoot.link,
  blobs: [schemaRoot.bytes],
  data: (document) => document,
  document(data) {
    const { title, fields, ...rest } = data;
    refuseMembers(rest, "a schema holds a title and fields alone");
    if (typeof title !== "string") throw new Error("a schema holds a title, a string");
    if (fields === undefined || !isJsonObject(fields)) throw new Error("a schema holds fields, each by name");
    for (const [name, field] of Object.entries(fields)) {
      if (name === "$schema") throw new Error("a field is not named $schema, which names the object's schema");
      validateField(field, `the field ${name}`);
    }
    return data as SchemaDocument;
  },
};

function validateField(field: Json, place: string): void {
  const { optional, ...type } = membersOf(field, place);
  if (optional !== undefined && optional !== true)
    throw new Error(`${place} is marked optional with true, or not marked`);
  validateType(type, place);
}

function validateType(value: Json, place: string): void {
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

function membersOf(value: Json, place: string): { readonly [name: string]: Json } {
  if (!isJsonObject(value)) throw new Error(`${place} is a JSON object`);
  return value;
}

function refuseMembers(members: { readonly [name: string]: Json }, rule: string): void {
  const names = Object.keys(members);
  if (names.length > 0) throw new Error(`${rule}, not ${names.join(", ")}`);
}
