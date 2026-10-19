import { dereference, validate, type Schema as CfworkerSchema } from "@cfworker/json-schema";
import { DRAFT_2020_12 } from "./builtins.ts";
import type { SchemaValidator } from "./schema.ts";

// Where a schema without `$id` is placed. Left to itself, cfworker resolves
// references against the page's URL in a browser; a URN admits fragments
// only, so a relative reference fails to compile in every runtime alike.
const anonymous = new URL("urn:estoc:schema");

/**
 * Validates draft 2020-12 with `@cfworker/json-schema`, which interprets
 * schemas instead of generating code and so runs under a strict content
 * security policy. It asserts `format`.
 */
export const defaultValidator: SchemaValidator = {
  compile(schema, builtins) {
    if (schema.$schema !== DRAFT_2020_12) throw new Error(`unsupported dialect ${schema.$schema}`);
    // dereference annotates the schema objects it walks, so it walks copies.
    const root = structuredClone(schema) as CfworkerSchema;
    const lookup = dereference(root, Object.create(null), anonymous);
    for (const [id, builtin] of builtins) {
      dereference({ ...structuredClone(builtin), $id: id } as CfworkerSchema, lookup);
    }
    // cfworker throws on an unresolved `$ref` only once validation reaches it.
    for (const subschema of Object.values(lookup)) {
      if (typeof subschema !== "object") continue;
      const target = subschema.__absolute_ref__;
      if (target !== undefined && lookup[target] === undefined) {
        throw new Error(`$ref ${subschema.$ref} does not resolve`);
      }
    }
    return (data) =>
      validate(data, root, "2020-12", lookup, false).errors.map(
        ({ instanceLocation, error }) => `${instanceLocation}: ${error}`,
      );
  },
};
