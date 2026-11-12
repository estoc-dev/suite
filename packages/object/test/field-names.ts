import { type Est, est, type SchemaValidator } from "../src/index.ts";

/** The names of the fields an object holds, or `"any"` for an object that holds any. */
export type FieldNames = { readonly fields: readonly string[] | "any" };

// A language for these tests, so that they turn on no language in use: a
// schema lists the names of the fields its objects hold, or takes any fields.
// Its root schema says that a schema holds `fields` alone.
export const fieldNames: SchemaValidator<Est, FieldNames> = {
  language: {
    encoding: est,
    root: { fields: ["fields"] },
    data: (document) => document,
    document({ fields }) {
      if (fields !== "any" && !(Array.isArray(fields) && fields.every((name) => typeof name === "string")))
        throw new Error("the fields of a schema are names, or any");
      return { fields };
    },
  },
  compile:
    ({ fields }) =>
    (data) =>
      fields === "any"
        ? []
        : [
            ...Object.keys(data)
              .filter((name) => !fields.includes(name))
              .map((name) => `#/${name}: not a field of the schema`),
            ...fields.filter((name) => !Object.hasOwn(data, name)).map((name) => `#/${name}: left out`),
          ],
};
