import type { EncodedObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOfRows, memberOf, recordedStatements } from "@estoc/store";
import { openedMailboxSchema } from "./schemas.ts";

const openedMailboxRowSchema = schema("Opened mailbox row", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

const openedMailbox = memberOf(openedMailboxSchema);

export const openedMailboxes = indexOfRows(openedMailboxRowSchema, {
  transport: openedMailbox.field("transport"),
  acknowledgement: openedMailbox.field("acknowledgement"),
}).reading(recordedStatements);
