import type { Signature, SignatureData, Signatures } from "@estoc/identity";
import { decodeObject, type Json, json, type Link, readObject, type Schema, schemaOf } from "@estoc/object";
import type { Index, View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, MailboxRequestData } from "./schemas.ts";

type AcknowledgementRow = readonly [acceptance: Link<Signature>, acknowledgement: Link<Signature>];

export type Acknowledgements = Index<Json, AcknowledgementRow, SignatureData>;

/** The acknowledgements that recorded signatures sign, by the acceptance each acknowledges. */
export function acknowledgements(
  signatures: Signatures,
  acknowledgement: Schema<Json, AcknowledgementData>,
): Acknowledgements {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== acknowledgement.link) return;
      yield [decodeObject(bytes, acknowledgement).data.acceptance.$link, signature.link as Link<Signature>];
    },
  };
}

/**
 * The least link of the signatures among a store's records over an
 * acknowledgement of `acceptance`, or `undefined` when it holds none.
 * Requests of one acceptance at once can each sign one, and the least is
 * the one that every service sharing the store answers with.
 */
export function acknowledgementOf(
  acknowledgements: Acknowledgements,
  acceptance: Link<Signature>,
): View<Json, AcknowledgementRow, Promise<Link<Signature> | undefined>, SignatureData> {
  return {
    index: acknowledgements,
    async read(rows) {
      for await (const [, link] of rows.range([acceptance])) return link;
      return undefined;
    },
  };
}

type MailboxAcknowledgementRow = readonly [sendId: string, key: string, acknowledgement: Link<Signature>];

export type MailboxAcknowledgements = Index<Json, MailboxAcknowledgementRow, SignatureData>;

/**
 * The mailboxes that recorded signatures acknowledge, by the id that
 * senders post to and the key that the request named.
 */
export function mailboxAcknowledgements(
  signatures: Signatures,
  schemas: {
    readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
    readonly mailboxRequest: Schema<Json, MailboxRequestData>;
  },
): MailboxAcknowledgements {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== schemas.mailboxAcknowledgement.link) return;
      const { request, sendId } = decodeObject(bytes, schemas.mailboxAcknowledgement).data;
      const { object } = (await readObject(reader, request.$link, signatures.schema)).data;
      const { key } = (await readObject(reader, object.$link, schemas.mailboxRequest)).data;
      yield [sendId, key, signature.link as Link<Signature>];
    },
  };
}

/**
 * The link of a signature among a store's records over the
 * acknowledgement of a mailbox at `sendId` sealed to `key`, or `undefined`
 * when it holds none.
 */
export function mailboxAcknowledgementAt(
  mailboxes: MailboxAcknowledgements,
  sendId: string,
  key: string,
): View<Json, MailboxAcknowledgementRow, Promise<Link<Signature> | undefined>, SignatureData> {
  return {
    index: mailboxes,
    async read(rows) {
      for await (const [, , link] of rows.range([sendId, key])) return link;
      return undefined;
    },
  };
}
