import { isJsonObject, json, type Json, type JsonObject } from "./json.ts";
import { LINK_PATTERN } from "./link.ts";
import type { SchemaLanguage, SchemaValidator } from "./schema.ts";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * A JSON Schema document. It names its dialect in `$schema` because the same
 * bytes mean different things in different drafts.
 */
export interface JsonSchema extends JsonObject {
  readonly $schema: string;
}

/**
 * JSON Schema over JSON: a schema is a JSON object naming its dialect in
 * `$schema`, written as JSON is, and with no `$type`, so that no blob reads
 * both as a schema and as an object. A dialect is a version of the language,
 * and a `$ref` is a reference: a `$ref` to anything outside the schema fails
 * compilation, and one in a place the dialect ignores, such as under `then`
 * without `if`, has no effect.
 */
export const jsonSchema: SchemaLanguage<JsonSchema, Json> = {
  encoding: json,
  encode: (schema) => json.encode(schema),
  decode(bytes) {
    const value = json.decode(bytes);
    if (!isJsonObject(value) || typeof value.$schema !== "string") {
      throw new Error("a schema is a JSON object naming its dialect in $schema");
    }
    if (Object.hasOwn(value, "$type")) throw new Error("a schema has no $type, which names the schema of an object");
    return value as JsonSchema;
  },
};

export type JsonSchemaValidator = SchemaValidator<JsonSchema, Json>;

/** Bytes in lowercase hex, as a pattern for a JSON Schema. */
export const HEX = /^(?:[0-9a-f]{2})*$/;

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
