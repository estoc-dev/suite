import type { SignedIdentityObject } from "@estoc/identity";
import type { EncodedObject, Json } from "@estoc/object";
import { array, bytes, type DataOf, type ItemOf, integer, link, schema } from "@estoc/schema";

/**
 * The schema of one transport's mailboxes.
 *
 * - Every mailbox has `key`, the x25519 public key that messages to it are sealed to.
 * - `fields` are the transport's own, and a mailbox holds no other.
 * - The title tells apart two transports whose fields look the same.
 *
 * @throws when `fields` names a field `key`.
 */
export function mailboxSchema<F extends Parameters<typeof schema>[1]>(
  title: string,
  fields: F,
): ReturnType<typeof schema<F & { readonly key: ItemOf<string> }>> {
  if (Object.hasOwn(fields, "key")) throw new Error("key is a field of every mailbox");
  return schema(title, { ...fields, key: bytes() });
}

/**
 * The schema of the key that opens what arrives at a mailbox of the user's:
 * the link of the mailbox, and `secret`, the x25519 secret key. One is kept
 * in a private store for each mailbox, so a key used at two transports is
 * two objects.
 */
export const mailboxKeySchema = await schema("Mailbox Key", {
  mailbox: link<EncodedObject<Json>>(),
  secret: bytes(),
});

export type MailboxKeyData = DataOf<typeof mailboxKeySchema>;

/**
 * The schema of a record that a bundle, named by the link of its root, went out to a mailbox. `at`
 * is when, in milliseconds since the Unix epoch, by the clock of the device that wrote the record.
 */
export const outboundSchema = await schema("Outbound", {
  bundle: link<never>(),
  mailbox: link<EncodedObject<Json>>(),
  at: integer(),
});

export type OutboundData = DataOf<typeof outboundSchema>;

/**
 * The schema of a Mailbox Grant, which says at which mailboxes whoever signs it takes messages
 * from someone.
 *
 * - `to` is the link of that someone's signed identity, the identity version the signer holds
 *   when it signs.
 * - `mailboxes` are the links of the mailboxes. A grant with none says the signer no longer takes
 *   their messages.
 * - `at` is when, in milliseconds since the Unix epoch, by the signer's clock.
 */
export const mailboxGrantSchema = await schema("Mailbox Grant", {
  to: link<SignedIdentityObject>(),
  mailboxes: array(link<EncodedObject<Json>>()),
  at: integer(),
});

export type MailboxGrantData = DataOf<typeof mailboxGrantSchema>;
