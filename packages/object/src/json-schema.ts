import { isJsonLink, isJsonObject, type Json, type JsonObject, json } from "./json.ts";
import { LINK_PATTERN, type Link } from "./link.ts";
import type { Schema, SchemaLanguage, SchemaValidator } from "./schema.ts";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * A JSON Schema document. It names its dialect in `$schema` because the same
 * bytes mean different things in different drafts.
 */
export interface JsonSchema extends JsonObject {
  readonly $schema: string;
}

/** @throws when the schema has an `x-follows` that is not a nonempty array of links. */
function predecessorsIn(schema: JsonObject): readonly Link<Schema<Json>>[] {
  const follows = schema["x-follows"];
  if (follows === undefined) return [];
  if (!Array.isArray(follows) || follows.length === 0 || !follows.every(isJsonLink))
    throw new Error('a schema names the schemas it follows in x-follows, a nonempty array of {"$link": <link>}');
  return follows.map(({ $link }) => $link);
}

/**
 * JSON Schema over JSON.
 *
 * - A schema is a JSON object naming its dialect in `$schema`, written as JSON is.
 * - A schema has no `$describedBy`, so that no blob reads both as a schema and as an object.
 * - A schema names the schemas it follows in `x-follows`, a nonempty array of links. A schema
 *   without the keyword follows none.
 * - A dialect is a version of the language, and a `$ref` is a reference: a `$ref` to anything
 *   outside the schema fails compilation, and one in a place the dialect ignores, such as under
 *   `then` without `if`, has no effect.
 */
export const jsonSchema: SchemaLanguage<JsonSchema, Json> = {
  encoding: json,
  encode: (schema) => json.encode(schema),
  decode(bytes) {
    const value = json.decode(bytes);
    if (!isJsonObject(value) || typeof value.$schema !== "string") {
      throw new Error("a schema is a JSON object naming its dialect in $schema");
    }
    if (Object.hasOwn(value, "$describedBy"))
      throw new Error("a schema has no $describedBy, which names the schema of an object");
    predecessorsIn(value);
    return value as JsonSchema;
  },
  predecessorsOf: predecessorsIn,
};

export type JsonSchemaValidator = SchemaValidator<JsonSchema, Json>;

/**
 * A link as JSON writes it, `{"$link": <link>}`, as a subschema to write
 * into a schema wherever its data holds one. A schema refers to nothing
 * outside itself, so each schema that takes a link carries this.
 */
export const linkSchema: JsonObject = {
  type: "object",
  required: ["$link"],
  // A schema is JSON too, so `properties: {"$link": …}` would be an object
  // with a `$link` member that is not a link, and refused.
  propertyNames: { const: "$link" },
  additionalProperties: { type: "string", pattern: LINK_PATTERN },
};
