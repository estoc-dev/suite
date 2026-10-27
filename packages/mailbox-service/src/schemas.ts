import {
  type IdentityObject,
  type JsonLink,
  type JsonObject,
  type JsonSchema,
  json,
  type Link,
  linkOf,
  linkSchema,
  type Signature,
} from "@estoc/object";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * An id that a service gives out in an address. The id of an offer is the
 * offer's link, so it names that offer for good, wherever and however often
 * the service starts.
 */
export const ID = /^sha256:[0-9a-f]{64}$/;

const idSchema: JsonObject = { type: "string", pattern: ID.source };

/**
 * What a service signs to say where it is and what it offers: at `at`, in
 * milliseconds since the Unix epoch by the service's clock, its identity is
 * reached at `origin`, and makes the offers listed, each as the link of the
 * service's signature over the offer and the id that takes acceptances of
 * it. Of the Services that one identity signs, the one with the latest `at`
 * says where it is now.
 */
export const serviceSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Service",
  type: "object",
  properties: {
    origin: { type: "string" },
    at: { type: "integer", minimum: 0 },
    offers: {
      type: "array",
      items: {
        type: "object",
        properties: { offer: linkSchema, accept: idSchema },
        required: ["offer", "accept"],
        additionalProperties: false,
      },
    },
  },
  required: ["origin", "at", "offers"],
  additionalProperties: false,
};

export type ServiceData = {
  readonly origin: string;
  readonly at: number;
  readonly offers: readonly { readonly offer: JsonLink<Signature>; readonly accept: string }[];
};

/**
 * A Service's form apart from when it was signed: two Services that say the
 * same, the same origin and the same offers, have one form, whatever their
 * `at`.
 */
export function formOf({ at: _, ...said }: ServiceData): Link<unknown> {
  return linkOf(json.encode(said));
}

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
