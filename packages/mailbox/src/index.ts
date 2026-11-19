export type { Correspondence, CorrespondenceIdentity } from "./correspondence.ts";
export {
  type GrantSeries,
  type MailboxGrant,
  type MailboxGrantRow,
  MailboxGrants,
  mailboxGrantRowSchema,
} from "./grant.ts";
export { MailboxKey } from "./key.ts";
export { type Mailbox, mailboxFrom, type Options, type Transport, UndeliveredMessage } from "./mailbox.ts";
export type { Arrival, Pickup } from "./pickup.ts";
export { type Delivery, type Inbox, type Outbox, Post, type PostOptions } from "./post.ts";
export {
  type MailboxGrantData,
  type MailboxKeyData,
  mailboxGrantSchema,
  mailboxKeySchema,
  mailboxSchema,
  type OutboundData,
  outboundSchema,
} from "./schema.ts";
