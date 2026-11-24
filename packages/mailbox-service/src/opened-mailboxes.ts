import { type EncodedObject, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, selectedRecords } from "@estoc/store";
import { openedMailboxSchema } from "./schemas.ts";

const openedMailboxRowSchema = schema("Opened mailbox row", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

export const openedMailboxes = indexOver(
  selectedRecords(objectsOf(openedMailboxSchema)),
  openedMailboxRowSchema,
  ({ data }) => [{ transport: data.transport, acknowledgement: data.acknowledgement }],
)
  .orderedBy("transport", "acknowledgement")
  .named("Opened Mailboxes");
