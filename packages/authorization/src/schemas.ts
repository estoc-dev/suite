import { type JsonSchema, linkSchema } from "@estoc/object";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * What an authorizer signs to let `agent`, the link of an identity object,
 * act for it.
 */
export const authorizationSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Authorization",
  type: "object",
  properties: {
    agent: linkSchema,
  },
  required: ["agent"],
  additionalProperties: false,
};

/**
 * What an agent signs to stand behind `target` for someone else: `chain`
 * holds the signatures over the authorizations that lead from them to the
 * agent, in order.
 */
export const proxySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Proxy",
  type: "object",
  properties: {
    target: linkSchema,
    chain: { type: "array", items: linkSchema, minItems: 1 },
  },
  required: ["target", "chain"],
  additionalProperties: false,
};
