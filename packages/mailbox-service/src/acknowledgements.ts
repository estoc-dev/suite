import type { Signature, SignatureData, Signatures } from "@estoc/identity";
import { decodeObject, type Json, json, type Link, readObject, type Schema, schemaOf } from "@estoc/object";
import type { Index, View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, MailboxRequestData } from "./schemas.ts";

type Acknowledged = readonly [accepted: Link<Signature>, acknowledgement: Link<Signature>];

export type Acknowledgements = Index<Json, Acknowledged, SignatureData>;

/** The acknowledgements that the signatures written as mine sign, by the acceptance each acknowledges. */
export function acknowledgements(
  signatures: Signatures,
  acknowledgement: Schema<Json, AcknowledgementData>,
): Acknowledgements {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== acknowledgement.link) return;
      yield [decodeObject(bytes, acknowledgement).data.accepted.$link, signature.link as Link<Signature>];
    },
  };
}

/**
 * The least link of the signatures that a store holds as mine over an
 * acknowledgement of `accepted`, or `undefined` when it holds none.
 * Requests of one acceptance at once can each sign one, and the least is
 * the one that every service sharing the store answers with.
 */
export function acknowledgementOf(
  acknowledgements: Acknowledgements,
  accepted: Link<Signature>,
): View<Json, Acknowledged, Promise<Link<Signature> | undefined>, SignatureData> {
  return {
    index: acknowledgements,
    async read(rows) {
      for await (const [, link] of rows.range([accepted])) return link;
      return undefined;
    },
  };
}

type Opened = readonly [send: string, key: string, acknowledgement: Link<Signature>];

export type OpenedMailboxes = Index<Json, Opened, SignatureData>;

/**
 * The mailboxes that the signatures written as mine acknowledge, by the id
 * that senders post to and the key that the request named.
 */
export function openedMailboxes(
  signatures: Signatures,
  schemas: {
    readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
    readonly mailboxRequest: Schema<Json, MailboxRequestData>;
  },
): OpenedMailboxes {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== schemas.mailboxAcknowledgement.link) return;
      const { accepted, send } = decodeObject(bytes, schemas.mailboxAcknowledgement).data;
      const request = await readObject(reader, accepted.$link, signatures.schema);
      const { key } = (await readObject(reader, request.data.object.$link, schemas.mailboxRequest)).data;
      yield [send, key, signature.link as Link<Signature>];
    },
  };
}

/**
 * The link of a signature that a store holds as mine over the
 * acknowledgement of a mailbox at `send` sealed to `key`, or `undefined`
 * when it holds none.
 */
export function openedAt(
  opened: OpenedMailboxes,
  send: string,
  key: string,
): View<Json, Opened, Promise<Link<Signature> | undefined>, SignatureData> {
  return {
    index: opened,
    async read(rows) {
      for await (const [, , link] of rows.range([send, key])) return link;
      return undefined;
    },
  };
}
