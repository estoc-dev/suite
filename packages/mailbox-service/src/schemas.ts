import type { KeyObject, Signature } from "@estoc/identity";
import {
  DRAFT_2020_12,
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
 * What a service signs to say where it is and what it offers: at `at`, in
 * milliseconds since the Unix epoch by the service's clock, its identity is
 * reached at `origin`, and makes the offers listed, each as the link of the
 * service's signature over the offer and the id that takes acceptances of
 * it. Of the Services that identities of one root sign, the latest says
 * where the service is now: the one with the greatest `at`, and of those with the same `at`, the
 * one whose signature has the greater link, compared as ASCII strings.
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
 * too. It names the root of the service's identity, so each service's offer
 * has a link of its own, and a signature over it accepts that service's
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

export type AccountOfferData = { readonly identity: JsonLink<KeyObject> };

/**
 * What a service signs to acknowledge an acceptance of its offer: `accepted`
 * is the link of the signature that accepted its offer, and `at` when the
 * service received it, in milliseconds since the Unix epoch by the service's
 * clock.
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

/**
 * An id that a service makes up for a mailbox it opens, 16 random bytes in
 * lowercase hex: one that senders post to, and one that the account picks
 * up at. Neither can be worked out from the other, nor from what the
 * mailbox is.
 */
export const MAILBOX_ID = /^[0-9a-f]{32}$/;

const mailboxIdSchema: JsonObject = { type: "string", pattern: MAILBOX_ID.source };

/**
 * What a service signs to offer mailboxes, under an account it opened, on
 * these terms: what waits is kept for `retention` milliseconds, a mailbox
 * holds at most `quota` bytes waiting, and a message is at most `size`
 * bytes. It names the root of the service's identity, as the offer of an
 * account does, so a request for it asks this service alone.
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

export type MailboxOfferData = MailboxTerms & { readonly identity: JsonLink<KeyObject> };

/**
 * What an identity signs to ask a service for a mailbox under the account
 * of its root: `offer` is the link of the offer of mailboxes, and `key` the
 * x25519 public key that messages to the mailbox are sealed to, as 32 bytes
 * in lowercase hex. Each mailbox has a key of its own, so each request is
 * one of its own too.
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
 * opened: `accepted` is the link of the signature over the request, `at`
 * when the service received it, in milliseconds since the Unix epoch by the
 * service's clock, `send` the id that senders post to, and `pickup` the id
 * that the account picks up at.
 */
export const mailboxAcknowledgementSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Mailbox acknowledgement",
  type: "object",
  properties: {
    accepted: linkSchema,
    at: { type: "integer", minimum: 0 },
    send: mailboxIdSchema,
    pickup: mailboxIdSchema,
  },
  required: ["accepted", "at", "send", "pickup"],
  additionalProperties: false,
};

export type MailboxAcknowledgementData = {
  readonly accepted: JsonLink<Signature>;
  readonly at: number;
  readonly send: string;
  readonly pickup: string;
};

/**
 * What an identity signs to pick up at a mailbox: `mailbox` is the link of
 * the service's signature over the mailbox's acknowledgement, and `done`
 * the links of the sealed bytes that the receiver is done with, which no
 * longer wait.
 */
export const pickupRequestSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Pickup request",
  type: "object",
  properties: { mailbox: linkSchema, done: { type: "array", items: linkSchema } },
  required: ["mailbox", "done"],
  additionalProperties: false,
};

export type PickupRequestData = {
  readonly mailbox: JsonLink<Signature>;
  readonly done: readonly JsonLink<Uint8Array>[];
};

/**
 * What a service answers a pickup with, unsigned: the links of sealed bytes
 * that wait at the mailbox, the earliest first, which come with it.
 */
export const waitingSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Waiting",
  type: "object",
  properties: { sealed: { type: "array", items: linkSchema } },
  required: ["sealed"],
  additionalProperties: false,
};

export type WaitingData = { readonly sealed: readonly JsonLink<Uint8Array>[] };
