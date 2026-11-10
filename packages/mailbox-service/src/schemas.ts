import type { Identifier, Signature } from "@estoc/identity";
import {
  DRAFT_2020_12,
  type EncodedObject,
  type Json,
  type JsonLink,
  type JsonObject,
  type JsonSchema,
  json,
  type Link,
  linkOf,
  linkSchema,
} from "@estoc/object";

/**
 * An id that a service gives out in an address. The id of an offer is the
 * offer's link, so it names that offer for good, wherever and however often
 * the service starts.
 */
export const ID = /^sha256:[0-9a-f]{64}$/;

const idSchema: JsonObject = { type: "string", pattern: ID.source };

/**
 * What a service signs to say where it is and what it offers.
 *
 * - At `at`, in milliseconds since the Unix epoch by the service's clock,
 *   its identity is reached at `origin` and makes the offers listed.
 * - Each offer is listed as the link of the service's signature over the
 *   offer and `acceptId`, the id that takes acceptances of it.
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
        properties: { offer: linkSchema, acceptId: idSchema },
        required: ["offer", "acceptId"],
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
  readonly offers: readonly { readonly offer: JsonLink<Signature>; readonly acceptId: string }[];
};

/**
 * A Service's form apart from when it was signed: two Services that say the
 * same, the same origin and the same offers, have one form, whatever their
 * `at`.
 */
export function formOf({ at: _, ...content }: ServiceData): Link<unknown> {
  return linkOf(json.encode(content));
}

/**
 * An origin that a client reached a service at, which the client gives as
 * the `via` of the Inbound records that keep what the service answered
 * there. One origin is one object, however often it is reached.
 */
export const originSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Origin",
  type: "object",
  properties: { origin: { type: "string" } },
  required: ["origin"],
  additionalProperties: false,
};

export type OriginData = { readonly origin: string };

/**
 * What a service signs to offer an account to any identity that signs it
 * too. It names the service by its identifier, so each service's offer has
 * a link of its own, and a signature over it accepts that service's
 * offer alone.
 */
export const accountOfferSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Account offer",
  type: "object",
  properties: { identity: linkSchema },
  required: ["identity"],
  additionalProperties: false,
};

export type AccountOfferData = { readonly identity: { readonly $link: Identifier } };

/**
 * What a service signs to acknowledge an acceptance of its offer:
 * `acceptance` is the link of the signature that accepted its offer, and
 * `at` when the service received it, in milliseconds since the Unix epoch
 * by the service's clock.
 */
export const acknowledgementSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Acknowledgement",
  type: "object",
  properties: { acceptance: linkSchema, at: { type: "integer", minimum: 0 } },
  required: ["acceptance", "at"],
  additionalProperties: false,
};

export type AcknowledgementData = { readonly acceptance: JsonLink<Signature>; readonly at: number };

/**
 * An id that a service makes up for a mailbox it opens, 16 random bytes in
 * lowercase hex: one that senders post to, and one that the account picks
 * up at. Neither can be worked out from the other, nor from what the
 * mailbox is.
 */
export const MAILBOX_ID = /^[0-9a-f]{32}$/;

const mailboxIdSchema: JsonObject = { type: "string", pattern: MAILBOX_ID.source };

/**
 * What a service signs to offer mailboxes under an account it opened.
 *
 * - What waits is kept for `retention` milliseconds.
 * - A mailbox holds at most `quota` bytes waiting.
 * - A message is at most `size` bytes.
 * - It names the service by its identifier, as the offer of an account
 *   does, so a request for it asks this service alone.
 */
export const mailboxOfferSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox offer",
  type: "object",
  properties: {
    identity: linkSchema,
    retention: { type: "integer", minimum: 1 },
    quota: { type: "integer", minimum: 1 },
    size: { type: "integer", minimum: 1 },
  },
  required: ["identity", "retention", "quota", "size"],
  additionalProperties: false,
};

export type MailboxTerms = { readonly retention: number; readonly quota: number; readonly size: number };

export type MailboxOfferData = MailboxTerms & { readonly identity: { readonly $link: Identifier } };

/**
 * What an identity signs to ask a service for a mailbox under its account:
 * `offer` is the link of the offer of mailboxes, and `key` the x25519 public
 * key that messages to the mailbox are sealed to, as 32 bytes in lowercase
 * hex. Each mailbox has a key of its own, so each request is one of its own
 * too.
 */
export const mailboxRequestSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox request",
  type: "object",
  properties: { offer: linkSchema, key: { type: "string", pattern: "^[0-9a-f]{64}$" } },
  required: ["offer", "key"],
  additionalProperties: false,
};

export type MailboxRequestData = { readonly offer: JsonLink<never>; readonly key: string };

/**
 * What a service signs to acknowledge a request for a mailbox, which it
 * opened: `request` is the link of the signature over the request, `at`
 * when the service received it, in milliseconds since the Unix epoch by the
 * service's clock, `sendId` the id that senders post to, and `pickupId` the
 * id that the account picks up at.
 */
export const mailboxAcknowledgementSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox acknowledgement",
  type: "object",
  properties: {
    request: linkSchema,
    at: { type: "integer", minimum: 0 },
    sendId: mailboxIdSchema,
    pickupId: mailboxIdSchema,
  },
  required: ["request", "at", "sendId", "pickupId"],
  additionalProperties: false,
};

export type MailboxAcknowledgementData = {
  readonly request: JsonLink<Signature>;
  readonly at: number;
  readonly sendId: string;
  readonly pickupId: string;
};

/**
 * What a client writes once a service acknowledged its request for a
 * mailbox, unsigned: `mailbox` is the link of the HTTP mailbox that senders
 * post to, and `acknowledgement` the link of the service's signature over
 * the mailbox's acknowledgement, which says where the mailbox is picked up.
 */
export const openedMailboxSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Opened mailbox",
  type: "object",
  properties: { mailbox: linkSchema, acknowledgement: linkSchema },
  required: ["mailbox", "acknowledgement"],
  additionalProperties: false,
};

export type OpenedMailboxData = {
  readonly mailbox: JsonLink<EncodedObject<Json>>;
  readonly acknowledgement: JsonLink<Signature>;
};

/**
 * What an identity signs to pick up at a mailbox: `mailbox` is the link of
 * the signature over the request that opened the mailbox, and `receipts` the
 * links of the ciphertexts that the receiver is done with, which no longer
 * wait.
 *
 * The mailbox goes by its request rather than by the service's signature over
 * its acknowledgement, which the service signs again once a crisis of its
 * root cuts the signature.
 */
export const pickupRequestSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Pickup request",
  type: "object",
  properties: { mailbox: linkSchema, receipts: { type: "array", items: linkSchema } },
  required: ["mailbox", "receipts"],
  additionalProperties: false,
};

export type PickupRequestData = {
  readonly mailbox: JsonLink<Signature>;
  readonly receipts: readonly JsonLink<Uint8Array>[];
};

/**
 * What a service answers a pickup with, unsigned: the links of the
 * ciphertexts that wait at the mailbox, the earliest first, which come with
 * it.
 */
export const pickupAnswerSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Pickup answer",
  type: "object",
  properties: { ciphertexts: { type: "array", items: linkSchema } },
  required: ["ciphertexts"],
  additionalProperties: false,
};

export type PickupAnswerData = { readonly ciphertexts: readonly JsonLink<Uint8Array>[] };
