export { MailboxKey } from "./key.ts";
export { type Mailbox, mailboxFrom, type Options, type Transport, Undelivered } from "./mailbox.ts";
export type { Arrival, Pickup } from "./pickup.ts";
export { type Delivery, type Inbox, loadPost, type Outbox, type Post, type PostOptions } from "./post.ts";
export {
  type DeliveryData,
  inboundSchema,
  type MailboxKeyData,
  mailboxKeySchema,
  mailboxSchema,
  outboundSchema,
} from "./schema.ts";
