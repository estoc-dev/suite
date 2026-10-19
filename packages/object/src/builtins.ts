import { publicKeyLengths } from "@estoc/identity";
import { LINK_PATTERN } from "./encoding.ts";
import type { JsonSchema } from "./schema.ts";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const identity: JsonSchema = {
  $schema: DRAFT_2020_12,
  type: "object",
  required: ["publicKey", "scheme"],
  properties: { publicKey: true, scheme: true },
  additionalProperties: false,
  oneOf: Object.entries(publicKeyLengths).map(([scheme, length]) => ({
    properties: {
      scheme: { const: scheme },
      publicKey: { type: "string", pattern: `^[0-9a-f]{${2 * length}}$` },
    },
  })),
};

const link: JsonSchema = {
  $schema: DRAFT_2020_12,
  type: "string",
  pattern: LINK_PATTERN,
};

/**
 * Schemas that any schema can `$ref` by these URLs. Validators are handed
 * them, so nothing is fetched.
 */
export const builtins: ReadonlyMap<string, JsonSchema> = new Map([
  ["https://estoc.dev/schema/identity", identity],
  ["https://estoc.dev/schema/link", link],
]);
