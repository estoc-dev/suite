import { identityKit } from "@estoc/identity";
import { type EncodedObject, type Link, LinkValue } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { indexOver, selectedRecords, type View, writtenObjectsOver } from "@estoc/store";
import { openedMailboxes } from "./opened-mailboxes.ts";
import { acknowledgementSchema } from "./schemas.ts";

const acknowledgementRowSchema = schema("Acknowledgement row", {
  acceptance: link(),
  acknowledgement: link(),
});

export const acknowledgements = indexOver(
  selectedRecords(writtenObjectsOver(identityKit.signatures.selectionOver(acknowledgementSchema))),
  acknowledgementRowSchema,
  ({ signature, object }) => [{ acceptance: object.data.acceptance, acknowledgement: new LinkValue(signature.link) }],
).orderedBy("acceptance", "acknowledgement");

export interface Acknowledgements {
  /**
   * Requests of one acceptance at once can each sign an acknowledgement, and every service sharing
   * the store goes by the one of the least link, so they answer alike.
   */
  acknowledgementOf(acceptance: Link<unknown>): Promise<Link<unknown> | undefined>;
}

export const acknowledgementsView: View<
  DataOf<typeof acknowledgements.rowSchema>,
  typeof acknowledgements.order,
  Acknowledgements
> = {
  index: acknowledgements,
  read: (rows) => ({
    async acknowledgementOf(acceptance) {
      for await (const { data } of rows.range([new LinkValue(acceptance)])) return data.acknowledgement.link;
      return undefined;
    },
  }),
};

/**
 * An acknowledgement that the store came to hold another way, such as at a mailbox, opens none: a
 * key that a later identity version of whoever holds the account takes out still signs requests by
 * the identity version before, so the signature does not tell a request sent while the key was
 * listed from one sent after.
 */
export interface OpenedMailboxes {
  acknowledgementOf(transport: Link<EncodedObject>): Promise<Link<unknown> | undefined>;
}

export const openedMailboxesView: View<
  DataOf<typeof openedMailboxes.rowSchema>,
  typeof openedMailboxes.order,
  OpenedMailboxes
> = {
  index: openedMailboxes,
  read: (rows) => ({
    async acknowledgementOf(transport) {
      for await (const { data } of rows.range([new LinkValue(transport)])) return data.acknowledgement.link;
      return undefined;
    },
  }),
};
