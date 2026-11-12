import type { Signature, Signatures } from "@estoc/identity";
import { type EncodedObject, type Link, LinkValue, objectsOf, type Value } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { indexOver, selectedRecords, type View } from "@estoc/store";
import { acknowledgementSchema, openedMailboxSchema } from "./schemas.ts";

/**
 * The schema of a signed acknowledgement as a row of an index: the acceptance
 * it acknowledges, and the signature over it.
 */
const acknowledgementRowSchema = schema("Acknowledgement row", {
  acceptance: link<Signature>(),
  acknowledgement: link<Signature>(),
});

type AcknowledgementOrder = readonly ["acceptance", "acknowledgement"];

/** The acknowledgements that recorded signatures sign, by the acceptance each acknowledges. */
export interface Acknowledgements {
  /**
   * The least link of the signatures over an acknowledgement of `acceptance`,
   * or `undefined` when the store holds none. Requests of one acceptance at
   * once can each sign one, and the least is the one that every service
   * sharing the store answers with.
   */
  acknowledgementOf(acceptance: Link<Signature>): Promise<Link<Signature> | undefined>;
}

export type AcknowledgementsView = View<
  Value,
  DataOf<typeof acknowledgementRowSchema>,
  AcknowledgementOrder,
  Acknowledgements
>;

export function acknowledgementsView(signatures: Signatures): AcknowledgementsView {
  return {
    index: indexOver(
      selectedRecords(signatures.selectionOver(acknowledgementSchema)),
      acknowledgementRowSchema,
      ({ signature, object }) => [
        { acceptance: object.data.acceptance, acknowledgement: new LinkValue(signature.link as Link<Signature>) },
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

/**
 * The schema of an opened mailbox as a row of an index: the mailbox, and the
 * service's signature over its acknowledgement.
 */
const openedMailboxRowSchema = schema("Opened mailbox row", {
  mailbox: link<EncodedObject<Value>>(),
  acknowledgement: link<Signature>(),
});

type OpenedMailboxOrder = readonly ["mailbox", "acknowledgement"];

/**
 * The mailboxes that the user's client opened, by the records that it
 * writes once a service acknowledged its request for each. An
 * acknowledgement that the store came to hold another way, such as at a
 * mailbox, opens none: a key that a later identity version of whoever holds
 * the account takes out still signs requests by the identity version before,
 * so the signature does not tell a request sent while the key was listed
 * from one sent after.
 */
export interface OpenedMailboxes {
  /**
   * The link of the service's signature over the acknowledgement of
   * `mailbox`, or `undefined` when the store holds no record of opening it.
   */
  acknowledgementOf(mailbox: Link<EncodedObject<Value>>): Promise<Link<Signature> | undefined>;
}

export type OpenedMailboxesView = View<
  Value,
  DataOf<typeof openedMailboxRowSchema>,
  OpenedMailboxOrder,
  OpenedMailboxes
>;

export function openedMailboxesView(): OpenedMailboxesView {
  return {
    index: indexOver(selectedRecords(objectsOf(openedMailboxSchema)), openedMailboxRowSchema, ({ data }) => [
      { mailbox: data.mailbox, acknowledgement: data.acknowledgement },
    ]).orderedBy("mailbox", "acknowledgement"),
    read: (rows) => ({
      async acknowledgementOf(mailbox) {
        for await (const { data } of rows.range([new LinkValue(mailbox)])) return data.acknowledgement.link;
        return undefined;
      },
    }),
  };
}
