import { type EncodedObject, type Link, LinkValue } from "@estoc/object";
import { verifiedSignaturesOf } from "@estoc/people";
import { type DataOf, link, schema } from "@estoc/schema";
import { linkedBlob, memberObjectOf, recordedWrittenObjects, type View } from "@estoc/store";
import { openedMailboxes } from "./opened-mailboxes.ts";
import { acknowledgementSchema } from "./schemas.ts";

const acknowledgementRowSchema = schema("Acknowledgement row", {
  acceptance: link(),
  acknowledgement: link(),
});

const acknowledgedAcceptanceSchema = schema("Acknowledged Acceptance", { acceptance: link() });

const signedAcknowledgements = verifiedSignaturesOf(
  acknowledgementSchema,
  recordedWrittenObjects.linksAt("object"),
).rowsJoinedAt(
  "object",
  linkedBlob.rowsTaking(acknowledgedAcceptanceSchema, {
    acceptance: memberObjectOf(acknowledgementSchema).field("acceptance"),
  }),
);

const signedAcknowledgement = memberObjectOf(signedAcknowledgements.rowSchema);

export const acknowledgements = signedAcknowledgements.rowsTaking(acknowledgementRowSchema, {
  acceptance: signedAcknowledgement.field("acceptance"),
  acknowledgement: signedAcknowledgement.field("signature"),
});

export interface Acknowledgements {
  /**
   * Requests of one acceptance at once can each sign an acknowledgement, and every service sharing
   * the store goes by the one of the least link, so they answer alike.
   */
  acknowledgementOf(acceptance: Link<unknown>): Promise<Link<unknown> | undefined>;
}

export const acknowledgementsView: View<DataOf<typeof acknowledgements.rowSchema>, Acknowledgements> = {
  index: acknowledgements,
  read: (rows) => {
    const orderedRows = rows.orderedBy("acceptance", "acknowledgement");
    return {
      async acknowledgementOf(acceptance) {
        for await (const { data } of orderedRows.range([new LinkValue(acceptance)])) return data.acknowledgement.link;
        return undefined;
      },
    };
  },
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

export const openedMailboxesView: View<DataOf<typeof openedMailboxes.rowSchema>, OpenedMailboxes> = {
  index: openedMailboxes,
  read: (rows) => {
    const orderedRows = rows.orderedBy("transport", "acknowledgement");
    return {
      async acknowledgementOf(transport) {
        for await (const { data } of orderedRows.range([new LinkValue(transport)])) return data.acknowledgement.link;
        return undefined;
      },
    };
  },
};
