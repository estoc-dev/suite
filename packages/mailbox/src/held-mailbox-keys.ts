import type { EncodedObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { memberObjectOf, recordedStatements } from "@estoc/store";
import { type MailboxData, type MailboxKeyData, mailboxKeySchema } from "./schema.ts";

const heldMailboxKeySchema = schema("Held Mailbox Key", {
  key: link<EncodedObject<MailboxKeyData>>(),
  mailbox: link<EncodedObject<MailboxData>>(),
  secret: link(),
});

const mailboxKey = memberObjectOf(mailboxKeySchema);

export const heldMailboxKeys = recordedStatements.rowsTaking(heldMailboxKeySchema, {
  key: mailboxKey.link,
  mailbox: mailboxKey.field("mailbox"),
  secret: mailboxKey.field("secret"),
});
