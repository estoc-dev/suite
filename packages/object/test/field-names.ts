import { encodeSchema, type SchemaDocument, type SchemaValidator } from "../src/index.ts";

// A validator for these tests, so that they turn on no validator in use: it checks which fields an
// object holds, and not what they hold.
export const fieldNames: SchemaValidator = {
  compile:
    ({ fields }) =>
    (data) => [
      ...Object.keys(data)
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => `#/${name}: not a field of the schema`),
      ...Object.keys(fields)
        .filter((name) => !Object.hasOwn(data, name))
        .map((name) => `#/${name}: left out`),
    ],
};

export const lenient: SchemaValidator = { compile: () => () => [] };

export const documentHolding = (title: string, ...names: string[]): SchemaDocument => ({
  title,
  fields: Object.fromEntries(names.map((name) => [name, { type: "any" }])),
});

export const anything = encodeSchema({ title: "Anything", fields: {} }, lenient);
