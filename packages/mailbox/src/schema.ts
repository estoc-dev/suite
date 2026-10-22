import type { JsonObject, JsonSchema } from "@estoc/object";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * The draft 2020-12 schema of one transport's mailboxes. Every mailbox has
 * `key`, the x25519 public key that messages to it are sealed to, as 32
 * bytes in lowercase hex. `properties` and `required` add the transport's
 * own fields, and no other field is allowed. The title tells apart two
 * transports whose fields look the same.
 */
export function mailboxSchema(
  title: string,
  properties: Readonly<Record<string, JsonObject>>,
  required: readonly string[] = [],
): JsonSchema {
  if (Object.hasOwn(properties, "key")) throw new Error("key is a field of every mailbox");
  return {
    $schema: DRAFT_2020_12,
    title,
    type: "object",
    properties: { ...properties, key: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    required: ["key", ...required],
    additionalProperties: false,
  };
}
