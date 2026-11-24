import { identityKit, type Signature, type SignedIdentityObject } from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import type { SeenIdentityVersions } from "@estoc/people";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { indexOver, selectedBlobs, type View } from "@estoc/store";
import { type MailboxData, type MailboxGrantData, mailboxGrantSchema } from "./schema.ts";

const { signatures, signedIdentities } = identityKit;

/**
 * Two grants of a series at one `at` are told apart by the links of their signatures, as two
 * identity versions are.
 */
const mailboxGrantRowSchema = schema("Mailbox Grant Row", {
  from: link(),
  to: link(),
  at: integer(),
  signature: link(),
});

export const mailboxGrants = indexOver(
  selectedBlobs(signatures.selectionOver(mailboxGrantSchema)),
  mailboxGrantRowSchema,
  async function* ({ signature, object }, reader) {
    const to = await signedIdentities.read(object.data.to.link, reader);
    yield {
      from: new LinkValue(signature.signedIdentity.identity.identifier),
      to: new LinkValue(to.identity.identifier),
      at: object.data.at,
      signature: new LinkValue(signature.link),
    };
  },
)
  .orderedBy("from", "to", "at", "signature")
  .named("Mailbox Grants");

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

export function mailboxGrantTo(
  to: SignedIdentityObject,
  mailboxes: readonly Link<EncodedObject<MailboxData>>[],
  at: number,
): EncodedObject<MailboxGrantData> {
  return encodeObject(mailboxGrantSchema, {
    to: new LinkValue(to.link),
    mailboxes: mailboxes.map((mailbox) => new LinkValue(mailbox)),
    at,
  });
}

export const grantSeriesView: View<DataOf<typeof mailboxGrants.rowSchema>, typeof mailboxGrants.order, GrantSeries> = {
  index: mailboxGrants,
  read: (rows, reader) => {
    const grantOf = async (signature: Signature): Promise<MailboxGrant> => {
      const object = await readObject(reader, signature.object, mailboxGrantSchema);
      return { object, signature, to: await signedIdentities.read(object.data.to.link, reader) };
    };
    const honoredSignatures = async function* (
      from: Link<unknown>,
      to: Link<unknown>,
      seenIdentityVersions: SeenIdentityVersions,
    ) {
      for await (const { data } of rows.range([new LinkValue(from), new LinkValue(to)])) {
        const signature = await signatures.read(data.signature.link, reader);
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
  },
};
