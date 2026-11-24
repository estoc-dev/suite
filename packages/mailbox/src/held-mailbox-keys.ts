import { type EncodedObject, LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, selectedRecords } from "@estoc/store";
import { type MailboxData, type MailboxKeyData, mailboxKeySchema } from "./schema.ts";

const heldMailboxKeySchema = schema("Held Mailbox Key", {
  key: link<EncodedObject<MailboxKeyData>>(),
  mailbox: link<EncodedObject<MailboxData>>(),
  secret: link(),
});

export const heldMailboxKeys = indexOver(
  selectedRecords(objectsOf(mailboxKeySchema)),
  heldMailboxKeySchema,
  ({ link, data }) => [{ key: new LinkValue(link), ...data }],
)
  .orderedBy("key")
  .named("Held Mailbox Keys");
