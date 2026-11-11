import { isJsonObject, type Json, json, type SchemaValidator } from "../src/index.ts";

/** The names of the fields an object holds. With no `fields`, an object holds any. */
export type FieldNames = { readonly fields?: readonly string[] };

// A language for these tests, so that they turn on no language in use: a
// schema lists the names of the fields its objects hold, or lists none and
// takes any fields.
export const fieldNames: SchemaValidator<Json, FieldNames> = {
  language: {
    encoding: json,
    value: (document) => document,
    document(value) {
      if (!isJsonObject(value)) throw new Error("a schema is a JSON object");
      const { fields, ...rest } = value;
      const extra = Object.keys(rest);
      if (extra.length > 0) throw new Error(`a schema holds fields alone, not ${extra.join(", ")}`);
      if (fields === undefined) return {};
      if (!Array.isArray(fields) || !fields.every((name) => typeof name === "string"))
        throw new Error("the fields of a schema are names");
      return { fields };
    },
  },
  compile:
    ({ fields }) =>
    (data) =>
      fields === undefined
        ? []
        : [
            ...Object.keys(data)
              .filter((name) => !fields.includes(name))
              .map((name) => `#/${name}: not a field of the schema`),
            ...fields.filter((name) => !Object.hasOwn(data, name)).map((name) => `#/${name}: left out`),
          ],
};
