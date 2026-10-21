import { LINK_PATTERN } from "./encoding.ts";
import type { JsonSchema } from "./schema.ts";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

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
  ["https://estoc.dev/schema/link", link],
]);
