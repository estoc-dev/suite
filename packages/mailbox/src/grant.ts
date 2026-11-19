import {
  type IdentityKit,
  noIdentityVersions,
  type SeenIdentityVersions,
  type Signature,
  type SignatureOver,
  type SignedIdentityObject,
} from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader, readObject } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { indexOver, type Rows, selectedBlobs, type View } from "@estoc/store";
import { type MailboxGrantData, mailboxGrantSchema } from "./schema.ts";

/**
 * Two grants of a series at one `at` are told apart by the links of their signatures, as two
 * identity versions are.
 */
export const mailboxGrantRowSchema = schema("Mailbox Grant Row", {
  from: link(),
  to: link(),
  at: integer(),
  signature: link(),
});

export type MailboxGrantRow = DataOf<typeof mailboxGrantRowSchema>;

type MailboxGrantOrder = readonly ["from", "to", "at", "signature"];

export interface MailboxGrant {
  readonly object: EncodedObject<MailboxGrantData>;
  readonly signature: Signature;
  readonly to: SignedIdentityObject;
}

export interface GrantSeries {
  grantsFrom(
    from: Link<unknown>,
    to: Link<unknown>,
    seenIdentityVersions: SeenIdentityVersions,
  ): AsyncIterable<MailboxGrant>;
  grantFrom(
    from: Link<unknown>,
    to: Link<unknown>,
    seenIdentityVersions: SeenIdentityVersions,
  ): Promise<MailboxGrant | undefined>;
}

type SignatureReading = Pick<IdentityKit, "signatures" | "signedIdentities">;

export class MailboxGrants {
  readonly schema = mailboxGrantSchema;
  /** Made once, with the grants, so a store keeps the rows of its index between scans. */
  readonly series: View<MailboxGrantRow, MailboxGrantOrder, GrantSeries>;
  readonly #identity: SignatureReading;

  constructor(identity: SignatureReading) {
    this.#identity = identity;
    this.series = {
      index: indexOver(
        selectedBlobs(identity.signatures.selectionOver(this.schema)),
        mailboxGrantRowSchema,
        (grant, reader) => this.#rowsOf(grant, reader),
      ).orderedBy("from", "to", "at", "signature"),
      read: (rows, reader) => this.#seriesOf(rows, reader),
    };
  }

  encode(
    to: SignedIdentityObject,
    mailboxes: readonly Link<EncodedObject>[],
    at: number,
  ): EncodedObject<MailboxGrantData> {
    return encodeObject(this.schema, {
      to: new LinkValue(to.link),
      mailboxes: mailboxes.map((mailbox) => new LinkValue(mailbox)),
      at,
    });
  }

  async *#rowsOf(
    { signature, object }: SignatureOver<MailboxGrantData>,
    reader: Reader,
  ): AsyncIterable<MailboxGrantRow> {
    const to = await this.#identity.signedIdentities.read(object.data.to.link, reader);
    yield {
      from: new LinkValue(signature.signedIdentity.identity.identifier),
      to: new LinkValue(to.identity.identifier),
      at: object.data.at,
      signature: new LinkValue(signature.link),
    };
  }

  #seriesOf(rows: Rows<MailboxGrantRow, MailboxGrantOrder>, reader: Reader): GrantSeries {
    const { signatures } = this.#identity;
    const grantOf = (signature: Signature) => this.#grantOf(signature, reader);
    const honoredSignatures = async function* (
      from: Link<unknown>,
      to: Link<unknown>,
      seenIdentityVersions: SeenIdentityVersions,
    ) {
      for await (const { data } of rows.range([new LinkValue(from), new LinkValue(to)])) {
        const signature = await signatures.read(data.signature.link, reader, noIdentityVersions);
        if (await seenIdentityVersions.honors(signature)) yield signature;
      }
    };
    return {
      grantsFrom: async function* (from, to, seenIdentityVersions) {
        for await (const signature of honoredSignatures(from, to, seenIdentityVersions)) yield grantOf(signature);
      },
      grantFrom: async (from, to, seenIdentityVersions) => {
        let latest: Signature | undefined;
        for await (const signature of honoredSignatures(from, to, seenIdentityVersions)) latest = signature;
        return latest === undefined ? undefined : grantOf(latest);
      },
    };
  }

  async #grantOf(signature: Signature, reader: Reader): Promise<MailboxGrant> {
    const object = await readObject(reader, signature.object, this.schema);
    return { object, signature, to: await this.#identity.signedIdentities.read(object.data.to.link, reader) };
  }
}
