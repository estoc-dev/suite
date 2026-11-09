import { type KeyObject, noIdentityVersions, type Signature, type Signatures } from "@estoc/identity";
import { type Json, type Link, readObject, type Schema } from "@estoc/object";
import { indexOver, indexOverBlobs, type View } from "@estoc/store";
import type {
  AcknowledgementData,
  MailboxAcknowledgementData,
  MailboxOfferData,
  MailboxRequestData,
} from "./schemas.ts";

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

type MailboxAcknowledgementRow = readonly [
  sendId: string,
  key: string,
  root: Link<KeyObject>,
  acknowledgement: Link<Signature>,
];

/**
 * The mailboxes that the signatures a store holds acknowledge, records or
 * not, by the id that senders post to, the key that the request named and
 * the root of the identity that signed the request.
 *
 * - An acknowledgement gives a row only when it is signed by the root that
 *   the request's offer names, and it and the request verify by the
 *   identity versions they carry.
 * - Anyone can send an acknowledgement to a mailbox. Without the root of the
 *   request, one that someone signs of their own request for their own
 *   offer, with the same send id and key, would read as the account's;
 *   without the root of the offer, one that someone signs of the account's
 *   request would.
 */
export interface MailboxAcknowledgements {
  /**
   * The link of a signature over the acknowledgement of a mailbox at
   * `sendId` sealed to `key`, of a request signed for `root`, or `undefined`
   * when the store holds none.
   */
  acknowledgementAt(sendId: string, key: string, root: Link<KeyObject>): Promise<Link<Signature> | undefined>;
}

export type MailboxAcknowledgementsView = View<MailboxAcknowledgementRow, MailboxAcknowledgements>;

export function mailboxAcknowledgementsView(
  signatures: Signatures,
  schemas: {
    readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
    readonly mailboxRequest: Schema<Json, MailboxRequestData>;
    readonly mailboxOffer: Schema<Json, MailboxOfferData>;
  },
): MailboxAcknowledgementsView {
  return {
    index: indexOverBlobs(
      signatures.selectionOver(schemas.mailboxAcknowledgement),
      async function* ({ signature, object: acknowledgement }, reader) {
        const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
        const { request, sendId } = acknowledgement.data;
        const requestSignature = await signatures.read(request.$link, reader, noIdentityVersions);
        const { offer, key } = (await readObject(reader, requestSignature.object, schemas.mailboxRequest)).data;
        const { identity } = (await readObject(reader, offer.$link, schemas.mailboxOffer)).data;
        if (identity.$link === signedIdentity.identity.root.link)
          yield [sendId, key, requestSignature.signedIdentity.identity.root.link, link];
      },
    ),
    read: (rows) => ({
      async acknowledgementAt(sendId, key, root) {
        for await (const [, , , link] of rows.range([sendId, key, root])) return link;
        return undefined;
      },
    }),
  };
}
