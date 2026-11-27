import type { EncodedObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { memberObjectOf, recordedStatements } from "@estoc/store";
import { openedMailboxSchema } from "./schemas.ts";

const openedMailboxRowSchema = schema("Opened mailbox row", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

const openedMailbox = memberObjectOf(openedMailboxSchema);

export const openedMailboxes = recordedStatements.rowsTaking(openedMailboxRowSchema, {
  transport: openedMailbox.field("transport"),
  acknowledgement: openedMailbox.field("acknowledgement"),
});
