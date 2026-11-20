import { type EncodedObject, type Link, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { array, bytes, type DataOf, integer, link, schema, string } from "@estoc/schema";

/**
 * The id of an offer is the offer's link, so it names that offer for good, wherever and however
 * often the service starts.
 */
export const ID = /^sha256:[0-9a-f]{64}$/;

/** `at` is in milliseconds since the Unix epoch by the service's clock. */
export const serviceSchema = schema("Service", {
  origin: string(),
  at: integer(),
  offers: array(link()),
});

export type ServiceData = DataOf<typeof serviceSchema>;

export function formOf({ at: _, ...content }: ServiceData): Link<unknown> {
  return linkOf(objectFormat.encode(new ObjectValue(serviceSchema.link, content)));
}

export const originSchema = schema("Origin", { origin: string() });

export type OriginData = DataOf<typeof originSchema>;

/**
 * It names the service by its identifier, so each service's offer has a link of its own, and a
 * signature over it accepts that service's offer alone.
 */
export const accountOfferSchema = schema("Account offer", { identity: link() });

export type AccountOfferData = DataOf<typeof accountOfferSchema>;

/**
 * `at` is when the service received the acceptance, in milliseconds since the Unix epoch by the
 * service's clock.
 */
export const acknowledgementSchema = schema("Acknowledgement", {
  acceptance: link(),
  at: integer(),
});

export type AcknowledgementData = DataOf<typeof acknowledgementSchema>;

/**
 * 16 random bytes, so neither the id that senders post to nor the one that the account picks up at
 * can be worked out from the other, nor from what the mailbox is.
 */
export const MAILBOX_ID = /^[0-9a-f]{32}$/;

/**
 * - What waits is kept for `retention` milliseconds.
 * - A mailbox holds at most `quota` bytes waiting.
 * - A message is at most `size` bytes.
 * - It names the service by its identifier, as the offer of an account does, so a request for it
 *   asks this service alone.
 */
export const mailboxOfferSchema = schema("Mailbox offer", {
  identity: link(),
  retention: integer(),
  quota: integer(),
  size: integer(),
});

export type MailboxOfferData = DataOf<typeof mailboxOfferSchema>;

export type MailboxTerms = Omit<MailboxOfferData, "identity">;

/** Each mailbox has a key of its own, so each request is one of its own too. */
export const mailboxRequestSchema = schema("Mailbox request", {
  offer: link<EncodedObject<MailboxOfferData>>(),
  key: bytes(),
});

export type MailboxRequestData = DataOf<typeof mailboxRequestSchema>;

/**
 * `at` is when the service received the request, in milliseconds since the Unix epoch by the
 * service's clock.
 */
export const mailboxAcknowledgementSchema = schema("Mailbox acknowledgement", {
  request: link(),
  at: integer(),
  sendId: bytes(),
  pickupId: bytes(),
});

export type MailboxAcknowledgementData = DataOf<typeof mailboxAcknowledgementSchema>;

export const openedMailboxSchema = schema("Opened mailbox", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

export type OpenedMailboxData = DataOf<typeof openedMailboxSchema>;

/**
 * The mailbox goes by its request rather than by the service's signature over its acknowledgement,
 * which the service signs again once a crisis of its root cuts the signature.
 */
export const pickupRequestSchema = schema("Pickup request", {
  mailbox: link(),
  receipts: array(link<Uint8Array>()),
});

export type PickupRequestData = DataOf<typeof pickupRequestSchema>;

export const pickupAnswerSchema = schema("Pickup answer", { ciphertexts: array(link<Uint8Array>()) });

export type PickupAnswerData = DataOf<typeof pickupAnswerSchema>;
