import type { Signatures } from "@estoc/identity";
import { type EncodedObject, type Link, LinkValue, objectsOf } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { indexOver, selectedRecords, type View, writtenObjectsOver } from "@estoc/store";
import { acknowledgementSchema, openedMailboxSchema } from "./schemas.ts";

const acknowledgementRowSchema = schema("Acknowledgement row", {
  acceptance: link(),
  acknowledgement: link(),
});

type AcknowledgementOrder = readonly ["acceptance", "acknowledgement"];

export interface Acknowledgements {
  /**
   * Requests of one acceptance at once can each sign an acknowledgement, and every service sharing
   * the store goes by the one of the least link, so they answer alike.
   */
  acknowledgementOf(acceptance: Link<unknown>): Promise<Link<unknown> | undefined>;
}

export type AcknowledgementsView = View<
  DataOf<typeof acknowledgementRowSchema>,
  AcknowledgementOrder,
  Acknowledgements
>;

export function acknowledgementsView(signatures: Signatures): AcknowledgementsView {
  return {
    index: indexOver(
      selectedRecords(writtenObjectsOver(signatures.selectionOver(acknowledgementSchema))),
      acknowledgementRowSchema,
      ({ signature, object }) => [
        { acceptance: object.data.acceptance, acknowledgement: new LinkValue(signature.link) },
      ],
    ).orderedBy("acceptance", "acknowledgement"),
    read: (rows) => ({
      async acknowledgementOf(acceptance) {
        for await (const { data } of rows.range([new LinkValue(acceptance)])) return data.acknowledgement.link;
        return undefined;
      },
    }),
  };
}

const openedMailboxRowSchema = schema("Opened mailbox row", {
  transport: link<EncodedObject>(),
  acknowledgement: link(),
});

type OpenedMailboxOrder = readonly ["transport", "acknowledgement"];

/**
 * An acknowledgement that the store came to hold another way, such as at a mailbox, opens none: a
 * key that a later identity version of whoever holds the account takes out still signs requests by
 * the identity version before, so the signature does not tell a request sent while the key was
 * listed from one sent after.
 */
export interface OpenedMailboxes {
  acknowledgementOf(transport: Link<EncodedObject>): Promise<Link<unknown> | undefined>;
}

export type OpenedMailboxesView = View<DataOf<typeof openedMailboxRowSchema>, OpenedMailboxOrder, OpenedMailboxes>;

export function openedMailboxesView(): OpenedMailboxesView {
  return {
    index: indexOver(selectedRecords(objectsOf(openedMailboxSchema)), openedMailboxRowSchema, ({ data }) => [
      { transport: data.transport, acknowledgement: data.acknowledgement },
    ]).orderedBy("transport", "acknowledgement"),
    read: (rows) => ({
      async acknowledgementOf(transport) {
        for await (const { data } of rows.range([new LinkValue(transport)])) return data.acknowledgement.link;
        return undefined;
      },
    }),
  };
}
