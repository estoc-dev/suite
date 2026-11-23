import { LinkValue, memberOf, rootSchemaOf, type SchemaValidator, type Value } from "@estoc/object";
import { type Field, type Item, type SchemaDocument, schemaLanguage } from "./document.ts";

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

function* problemsIn(value: Value, field: Field | Item, path: string): Generator<string> {
  if (!fits[field.type](value)) yield `${path}: ${mismatch[field.type]}`;
  else if (field.type === "array")
    for (const [index, item] of (value as readonly Value[]).entries())
      yield* problemsIn(item, field.items, `${path}/${index}`);
}

/**
 * The language says what fits a schema, with nothing left to a validator, so another would give the
 * same answers.
 */
export const schemaValidator: SchemaValidator<SchemaDocument> = {
  language: schemaLanguage,
  compile({ fields }) {
    return (data) => {
      const problems = Object.keys(data)
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => `#/${name}: not a field of the schema`);
      for (const [name, field] of Object.entries(fields)) {
        const value = memberOf(data, name);
        if (value !== undefined) problems.push(...problemsIn(value, field, `#/${name}`));
        else if (field.optional !== true) problems.push(`#/${name}: left out`);
      }
      return problems;
    };
  },
};

export const rootSchema = rootSchemaOf(schemaValidator);
