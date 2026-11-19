import type { EncodedObject } from "@estoc/object";
import { array, bytes, type DataOf, type ItemOf, integer, link, schema } from "@estoc/schema";

export function mailboxSchema<F extends Parameters<typeof schema>[1]>(
  title: string,
  fields: F,
): ReturnType<typeof schema<F & { readonly key: ItemOf<Uint8Array> }>> {
  if (Object.hasOwn(fields, "key")) throw new Error("key is a field of every mailbox");
  return schema(title, { ...fields, key: bytes() });
}

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
