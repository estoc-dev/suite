import { isJsonLink, type Json, type SchemaValidator } from "@estoc/object";
import { type Field, type Item, type SchemaDocument, schemaLanguage } from "./document.ts";

const hex = /^(?:[0-9a-f]{2})*$/;

const fits: { readonly [T in Item["type"]]: (value: Json) => boolean } = {
  array: Array.isArray,
  link: isJsonLink,
  bytes: (value) => typeof value === "string" && hex.test(value),
  integer: Number.isSafeInteger,
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
};

const mismatch: { readonly [T in Item["type"]]: string } = {
  array: "not an array",
  link: "not a link",
  bytes: "not bytes in lowercase hex",
  integer: "not an integer of at most 2^53 - 1 either way",
  string: "not a string",
  boolean: "not a boolean",
};

function* problemsIn(value: Json, field: Field | Item, path: string): Generator<string> {
  if (!fits[field.type](value)) yield `${path}: ${mismatch[field.type]}`;
  else if (field.type === "array")
    for (const [index, item] of (value as readonly Json[]).entries())
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
export const schemaValidator: SchemaValidator<Json, SchemaDocument> = {
  language: schemaLanguage,
  async compile({ fields }) {
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
