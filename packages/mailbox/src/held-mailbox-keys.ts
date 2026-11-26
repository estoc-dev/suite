import type { EncodedObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOfRows, recordedStatement } from "@estoc/store";
import { type MailboxData, type MailboxKeyData, mailboxKeySchema } from "./schema.ts";

const heldMailboxKeySchema = schema("Held Mailbox Key", {
  key: link<EncodedObject<MailboxKeyData>>(),
  mailbox: link<EncodedObject<MailboxData>>(),
  secret: link(),
});

const mailboxKey = recordedStatement(mailboxKeySchema);

export const heldMailboxKeys = indexOfRows(heldMailboxKeySchema, {
  key: mailboxKey.link,
  mailbox: mailboxKey.field("mailbox"),
  secret: mailboxKey.field("secret"),
});
