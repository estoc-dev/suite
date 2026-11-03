import type { Signature, Signatures } from "@estoc/identity";
import { type Json, type Link, readObject, type Schema } from "@estoc/object";
import { indexOver, type View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, MailboxRequestData } from "./schemas.ts";

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

export function acknowledgementsView(
  signatures: Signatures,
  acknowledgement: Schema<Json, AcknowledgementData>,
): AcknowledgementsView {
  return {
    index: indexOver(signatures.selectionOver(acknowledgement), ({ signature, object }) => [
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

type MailboxAcknowledgementRow = readonly [sendId: string, key: string, acknowledgement: Link<Signature>];

/**
 * The mailboxes that recorded signatures acknowledge, by the id that
 * senders post to and the key that the request named.
 */
export interface MailboxAcknowledgements {
  /**
   * The link of a signature over the acknowledgement of a mailbox at
   * `sendId` sealed to `key`, or `undefined` when the store holds none.
   */
  acknowledgementAt(sendId: string, key: string): Promise<Link<Signature> | undefined>;
}

export type MailboxAcknowledgementsView = View<MailboxAcknowledgementRow, MailboxAcknowledgements>;

export function mailboxAcknowledgementsView(
  signatures: Signatures,
  schemas: {
    readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
    readonly mailboxRequest: Schema<Json, MailboxRequestData>;
  },
): MailboxAcknowledgementsView {
  return {
    index: indexOver(
      signatures.selectionOver(schemas.mailboxAcknowledgement),
      async function* ({ signature, object: acknowledgement }, reader) {
        const { request, sendId } = acknowledgement.data;
        const { object } = (await readObject(reader, request.$link, signatures.schema)).data;
        const { key } = (await readObject(reader, object.$link, schemas.mailboxRequest)).data;
        yield [sendId, key, signature.link as Link<Signature>];
      },
    ),
    read: (rows) => ({
      async acknowledgementAt(sendId, key) {
        for await (const [, , link] of rows.range([sendId, key])) return link;
        return undefined;
      },
    }),
  };
}
