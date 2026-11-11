import type { KeyObject, Signature } from "@estoc/identity";
import { type EncodedObject, type Json, json, type Link, linkOf } from "@estoc/object";
import { array, bytes, type DataOf, integer, link, schema, string } from "@estoc/schema";

/**
 * An id that a service gives out in an address. The id of an offer is the
 * offer's link, so it names that offer for good, wherever and however often
 * the service starts.
 */
export const ID = /^sha256:[0-9a-f]{64}$/;

/**
 * What a service signs to say where it is and what it offers.
 *
 * - At `at`, in milliseconds since the Unix epoch by the service's clock,
 *   its identity is reached at `origin` and makes the offers listed.
 * - Each offer is listed as the link of the service's signature over it.
 *   The id that takes acceptances of an offer is the link of the offer,
 *   which that signature names as its object.
 */
export const serviceSchema = await schema("Service", {
  origin: string(),
  at: integer(),
  offers: array(link<Signature>()),
});

export type ServiceData = DataOf<typeof serviceSchema>;

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
export const originSchema = await schema("Origin", { origin: string() });

export type OriginData = DataOf<typeof originSchema>;

/**
 * What a service signs to offer an account to any identity that signs it
 * too. It names the service by its identifier, so each service's offer has
 * a link of its own, and a signature over it accepts that service's
 * offer alone.
 */
export const accountOfferSchema = await schema("Account offer", { identity: link<KeyObject>() });

export type AccountOfferData = DataOf<typeof accountOfferSchema>;

/**
 * What a service signs to acknowledge an acceptance of its offer:
 * `acceptance` is the link of the signature that accepted its offer, and
 * `at` when the service received it, in milliseconds since the Unix epoch
 * by the service's clock.
 */
export const acknowledgementSchema = await schema("Acknowledgement", {
  acceptance: link<Signature>(),
  at: integer(),
});

export type AcknowledgementData = DataOf<typeof acknowledgementSchema>;

/**
 * An id that a service makes up for a mailbox it opens, 16 random bytes in
 * lowercase hex: one that senders post to, and one that the account picks
 * up at. Neither can be worked out from the other, nor from what the
 * mailbox is.
 */
export const MAILBOX_ID = /^[0-9a-f]{32}$/;

/**
 * What a service signs to offer mailboxes under an account it opened.
 *
 * - What waits is kept for `retention` milliseconds.
 * - A mailbox holds at most `quota` bytes waiting.
 * - A message is at most `size` bytes.
 * - It names the service by its identifier, as the offer of an account
 *   does, so a request for it asks this service alone.
 */
export const mailboxOfferSchema = await schema("Mailbox offer", {
  identity: link<KeyObject>(),
  retention: integer(),
  quota: integer(),
  size: integer(),
});

export type MailboxOfferData = DataOf<typeof mailboxOfferSchema>;

export type MailboxTerms = Omit<MailboxOfferData, "identity">;

/**
 * What an identity signs to ask a service for a mailbox under its account:
 * `offer` is the link of the offer of mailboxes, and `key` the x25519 public
 * key that messages to the mailbox are sealed to. Each mailbox has a key of
 * its own, so each request is one of its own too.
 */
export const mailboxRequestSchema = await schema("Mailbox request", { offer: link<never>(), key: bytes() });

export type MailboxRequestData = DataOf<typeof mailboxRequestSchema>;

/**
 * What a service signs to acknowledge a request for a mailbox, which it
 * opened: `request` is the link of the signature over the request, `at`
 * when the service received it, in milliseconds since the Unix epoch by the
 * service's clock, `sendId` the id that senders post to, and `pickupId` the
 * id that the account picks up at.
 */
export const mailboxAcknowledgementSchema = await schema("Mailbox acknowledgement", {
  request: link<Signature>(),
  at: integer(),
  sendId: bytes(),
  pickupId: bytes(),
});

export type MailboxAcknowledgementData = DataOf<typeof mailboxAcknowledgementSchema>;

/**
 * What a client writes once a service acknowledged its request for a
 * mailbox, unsigned: `mailbox` is the link of the HTTP mailbox that senders
 * post to, and `acknowledgement` the link of the service's signature over
 * the mailbox's acknowledgement, which says where the mailbox is picked up.
 */
export const openedMailboxSchema = await schema("Opened mailbox", {
  mailbox: link<EncodedObject<Json>>(),
  acknowledgement: link<Signature>(),
});

export type OpenedMailboxData = DataOf<typeof openedMailboxSchema>;

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
export const pickupRequestSchema = await schema("Pickup request", {
  mailbox: link<Signature>(),
  receipts: array(link<Uint8Array>()),
});

export type PickupRequestData = DataOf<typeof pickupRequestSchema>;

/**
 * What a service answers a pickup with, unsigned: the links of the
 * ciphertexts that wait at the mailbox, the earliest first, which come with
 * it.
 */
export const pickupAnswerSchema = await schema("Pickup answer", { ciphertexts: array(link<Uint8Array>()) });

export type PickupAnswerData = DataOf<typeof pickupAnswerSchema>;
