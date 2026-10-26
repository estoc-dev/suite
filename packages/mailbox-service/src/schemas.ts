import {
  type IdentityObject,
  type JsonLink,
  type JsonSchema,
  linkSchema,
  type Signature,
} from "@estoc/object";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * What a service signs to offer an account to any identity that signs it
 * too. It names the service's identity, so each service's offer has a link
 * of its own, and a signature over it accepts that service's offer alone.
 */
export const accountOfferSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Account offer",
  type: "object",
  properties: { identity: linkSchema },
  required: ["identity"],
  additionalProperties: false,
};

export type AccountOfferData = { readonly identity: JsonLink<IdentityObject> };

/**
 * What a service signs once it opens an account: `accepted` is the link of
 * the signature that accepted its offer, and `at` when the service received
 * it, in milliseconds since the Unix epoch by the service's clock.
 */
export const acknowledgementSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Acknowledgement",
  type: "object",
  properties: { accepted: linkSchema, at: { type: "integer", minimum: 0 } },
  required: ["accepted", "at"],
  additionalProperties: false,
};

export type AcknowledgementData = { readonly accepted: JsonLink<Signature>; readonly at: number };
