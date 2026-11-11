import type { Signature, Signatures } from "@estoc/identity";
import { type EncodedObject, type Json, type Link, objectsOf } from "@estoc/object";
import { indexOver, type View } from "@estoc/store";
import { acknowledgementSchema, openedMailboxSchema } from "./schemas.ts";

type AcknowledgementRow = readonly [acceptance: Link<Signature>, acknowledgement: Link<Signature>];

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

export type AcknowledgementsView = View<AcknowledgementRow, Acknowledgements>;

export function acknowledgementsView(signatures: Signatures): AcknowledgementsView {
  return {
    index: indexOver(signatures.selectionOver(acknowledgementSchema), ({ signature, object }) => [
      [object.data.acceptance.$link, signature.link as Link<Signature>],
    ]),
    read: (rows) => ({
      async acknowledgementOf(acceptance) {
        for await (const [, link] of rows.range([acceptance])) return link;
        return undefined;
      },
    }),
  };
}

type OpenedMailboxRow = readonly [mailbox: Link<EncodedObject<Json>>, acknowledgement: Link<Signature>];

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
  acknowledgementOf(mailbox: Link<EncodedObject<Json>>): Promise<Link<Signature> | undefined>;
}

export type OpenedMailboxesView = View<OpenedMailboxRow, OpenedMailboxes>;

export function openedMailboxesView(): OpenedMailboxesView {
  return {
    index: indexOver(objectsOf(openedMailboxSchema), ({ data }) => [[data.mailbox.$link, data.acknowledgement.$link]]),
    read: (rows) => ({
      async acknowledgementOf(mailbox) {
        for await (const [, link] of rows.range([mailbox])) return link;
        return undefined;
      },
    }),
  };
}
