import { isJsonObject, type Json, type JsonObject, json } from "./json.ts";
import { LINK_PATTERN } from "./link.ts";
import { type SelfDescribingObject, selfDescribingObject } from "./object.ts";
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
 * The root of JSON Schema, `{"$schema": null, "language": "JSON Schema"}`,
 * which stands for the language rather than one of its dialects.
 */
export const jsonSchemaRoot: SelfDescribingObject<Json> = selfDescribingObject(json, { language: "JSON Schema" });

/**
 * JSON Schema over JSON, whose schemas are written to `jsonSchemaRoot`.
 *
 * - The data of a schema is its `document` alone, a whole JSON Schema: a JSON object naming its
 *   dialect in `$schema`, with nothing added, so any JSON Schema tool can validate with it as it is.
 *   The schema's `$schema` and the document's are at different depths, and do not meet.
 * - A dialect is a version of the language, and a `$ref` is a reference: a `$ref` to anything
 *   outside the document fails compilation, and one in a place the dialect ignores, such as under
 *   `then` without `if`, has no effect.
 */
export const jsonSchema: SchemaLanguage<Json, JsonSchema> = {
  encoding: json,
  link: jsonSchemaRoot.link,
  blobs: [jsonSchemaRoot.bytes],
  data: (document) => ({ document }),
  document({ document, ...rest }) {
    if (document === undefined) throw new Error("a schema holds a document");
    const extra = Object.keys(rest);
    if (extra.length > 0) throw new Error(`a schema holds a document alone, not ${extra.join(", ")}`);
    if (!isJsonObject(document) || typeof document.$schema !== "string") {
      throw new Error("a JSON Schema document is a JSON object naming its dialect in $schema");
    }
    return document as JsonSchema;
  },
};

export type JsonSchemaValidator = SchemaValidator<Json, JsonSchema>;

/**
 * A link as JSON writes it, `{"$link": <link>}`, as a subschema to write
 * into a document wherever its data holds one. A document refers to nothing
 * outside itself, so each document that takes a link carries this.
 */
export const linkSchema: JsonObject = {
  type: "object",
  required: ["$link"],
  // A document is JSON too, so `properties: {"$link": …}` would be an object
  // with a `$link` member that is not a link, and refused.
  propertyNames: { const: "$link" },
  additionalProperties: { type: "string", pattern: LINK_PATTERN },
};
