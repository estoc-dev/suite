import type { EncodedObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOfRows, recordedStatement } from "@estoc/store";
import { openedMailboxSchema } from "./schemas.ts";

const openedMailboxRowSchema = schema("Opened mailbox row", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

const openedMailbox = recordedStatement(openedMailboxSchema);

export const openedMailboxes = indexOfRows(openedMailboxRowSchema, {
  transport: openedMailbox.field("transport"),
  acknowledgement: openedMailbox.field("acknowledgement"),
})
  .orderedBy("transport", "acknowledgement")
  .named("Opened Mailboxes");
