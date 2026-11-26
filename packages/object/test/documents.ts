import { encodeSchema, type Schema, type SchemaDocument } from "../src/index.ts";

export const documentHolding = (title: string, ...names: string[]): SchemaDocument => ({
  title,
  fields: Object.fromEntries(names.map((name) => [name, { type: "any" }])),
});

export const schemaTaking = (...names: string[]): Schema =>
  encodeSchema({
    title: "Anything",
    fields: Object.fromEntries(names.map((name) => [name, { type: "any", optional: true }])),
  });
