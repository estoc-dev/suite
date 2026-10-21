import { decodeJson, encodeJson, isJsonObject, LINK_PATTERN, type Bytes, type Json, type JsonObject, type Link } from "./encoding.ts";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * A JSON Schema document. It names its dialect in `$schema` because the same
 * bytes mean different things in different drafts.
 */
export interface JsonSchema extends JsonObject {
  readonly $schema: string;
}

/**
 * A link, as a subschema to write into a schema wherever its data holds one.
 * A schema refers to nothing outside itself, so each schema that takes a
 * link carries this.
 */
export const linkSchema: JsonObject = { type: "string", pattern: LINK_PATTERN };

/** Lists what in a value does not fit a schema; an empty list means it fits. */
export type Check = (data: Json) => readonly string[];

/**
 * Compiles JSON Schemas into checks. A signature commits to bytes and a
 * validator is one reading of them, so a stricter validator can replace
 * another without any blob changing. Where validators differ, as over
 * `format` or regular expression dialects, is theirs to decide; every
 * validator works offline and keeps to three rules:
 *
 * - A `$ref` to anything outside the schema fails compilation, rather than
 *   the validation that reaches it, so that the link of a schema fixes all
 *   that its data is checked against. A `$ref` in a place the dialect
 *   ignores, such as under `then` without `if`, has no effect.
 * - The same schema and value give the same answer every time.
 * - A dialect it does not support fails compilation.
 */
export interface SchemaValidator {
  /** Rejects when the schema cannot be compiled. */
  compile(schema: JsonSchema): Promise<Check>;
}

/** A JSON Schema as a blob, compiled by the validator it was read with. */
export class Schema {
  readonly value: JsonSchema;
  readonly bytes: Bytes<Schema>;
  readonly link: Link<Schema>;
  readonly #check: Check;

  constructor(value: JsonSchema, bytes: Bytes<Schema>, link: Link<Schema>, check: Check) {
    this.value = value;
    this.bytes = bytes;
    this.link = link;
    this.#check = check;
  }

  /** Lists what in `data` does not fit this schema; an empty list means it fits. */
  validate(data: Json): readonly string[] {
    return this.#check(data);
  }
}

export async function decodeSchema(bytes: Bytes<Schema>, validator: SchemaValidator): Promise<Schema> {
  const decoded = decodeJson(bytes);
  const { value } = decoded;
  if (!isJsonObject(value) || typeof value.$schema !== "string") {
    throw new Error("a schema is a JSON object naming its dialect in $schema");
  }
  const schema = value as JsonSchema;
  return new Schema(schema, decoded.bytes, decoded.link, await validator.compile(schema));
}

export async function encodeSchema(schema: JsonSchema, validator: SchemaValidator): Promise<Schema> {
  return decodeSchema(encodeJson(schema), validator);
}
