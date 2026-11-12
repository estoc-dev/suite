import { LinkValue, rootSchemaOf, type SchemaValidator, type Value } from "@estoc/object";
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
 * The validator of the language. The language says what fits a schema, with
 * nothing left to a validator, so another would give the same answers.
 *
 * - Data fits when its members are the fields of the schema, none but the optional ones left
 *   out, and each is a value of its field's type.
 * - Each problem names where in the data it is, as `#/agents/0: not a link`.
 */
export const schemaValidator: SchemaValidator<Value, SchemaDocument> = {
  language: schemaLanguage,
  compile({ fields }) {
    return (data) => {
      const problems = Object.keys(data)
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => `#/${name}: not a field of the schema`);
      for (const [name, field] of Object.entries(fields)) {
        const value = Object.hasOwn(data, name) ? data[name] : undefined;
        if (value !== undefined) problems.push(...problemsIn(value, field, `#/${name}`));
        else if (field.optional !== true) problems.push(`#/${name}: left out`);
      }
      return problems;
    };
  },
};

/**
 * The root schema of the language, which every schema of it is written to, itself included. It
 * is in the closure of every object of the language, so it goes where they go.
 */
export const rootSchema = rootSchemaOf(schemaValidator);
