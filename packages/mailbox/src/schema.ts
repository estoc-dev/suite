import type { EncodedObject } from "@estoc/object";
import { array, bytes, type DataOf, integer, link, schema } from "@estoc/schema";

/** `key` is an x25519 public key, 32 bytes. */
export const mailboxSchema = schema("Mailbox", {
  key: bytes(),
  transport: link<EncodedObject>(),
});

export type MailboxData = DataOf<typeof mailboxSchema>;

export const mailboxKeySchema = schema("Mailbox Key", {
  mailbox: link<EncodedObject>(),
  secret: bytes(),
});

export type MailboxKeyData = DataOf<typeof mailboxKeySchema>;

/** `at` is in milliseconds since the Unix epoch, by the clock of the device that wrote the mark. */
export const outboundSchema = schema("Outbound", {
  bundle: link<never>(),
  mailbox: link<EncodedObject>(),
  at: integer(),
});

export type OutboundData = DataOf<typeof outboundSchema>;

/**
 * A grant with no `mailboxes` says the signer no longer takes the messages of whoever it is to.
 * `at` is in milliseconds since the Unix epoch, by the signer's clock.
 */
export const mailboxGrantSchema = schema("Mailbox Grant", {
  to: link(),
  mailboxes: array(link<EncodedObject>()),
  at: integer(),
});

export type MailboxGrantData = DataOf<typeof mailboxGrantSchema>;
