import { identityKit, type Signature, type SignedIdentityObject } from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { identityVersionsOver, type SeenIdentityVersions, verifiedSignaturesOf } from "@estoc/people";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { heldBlobs, linkedBlob, memberObjectOf, type View } from "@estoc/store";
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

const grantSignatures = verifiedSignaturesOf(mailboxGrantSchema, heldBlobs);
const grantSignature = memberObjectOf(grantSignatures.rowSchema);
const grant = memberObjectOf(mailboxGrantSchema);

const signedGrantSchema = schema("Signed Mailbox Grant", { from: link(), signature: link(), grant: link() });
const grantRecipientSchema = schema("Mailbox Grant Recipient", { grantedAt: integer(), grantee: link() });

// The fields are named apart from those of an identity version, which the rows are joined to.
const grantsToIdentityVersions = grantSignatures
  .rowsTaking(signedGrantSchema, {
    from: grantSignature.field("identifier"),
    signature: grantSignature.field("signature"),
    grant: grantSignature.field("object"),
  })
  .rowsJoinedAt(
    "grant",
    linkedBlob.rowsTaking(grantRecipientSchema, { grantedAt: grant.field("at"), grantee: grant.field("to") }),
  )
  .rowsJoinedAt("grantee", identityVersionsOver(linkedBlob));

const grantToIdentityVersion = memberObjectOf(grantsToIdentityVersions.rowSchema);

export const mailboxGrants = grantsToIdentityVersions.rowsTaking(mailboxGrantRowSchema, {
  from: grantToIdentityVersion.field("from"),
  to: grantToIdentityVersion.field("identifier"),
  at: grantToIdentityVersion.field("grantedAt"),
  signature: grantToIdentityVersion.field("signature"),
});

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

export const grantSeriesView: View<DataOf<typeof mailboxGrants.rowSchema>, GrantSeries> = {
  index: mailboxGrants,
  read: (rows, reader) => {
    const orderedRows = rows.orderedBy("from", "to", "at", "signature");
    const grantOf = async (signature: Signature): Promise<MailboxGrant> => {
      const object = await readObject(reader, signature.object, mailboxGrantSchema);
      return { object, signature, to: await signedIdentities.read(object.data.to.link, reader) };
    };
    const honoredSignatures = async function* (
      from: Link<unknown>,
      to: Link<unknown>,
      seenIdentityVersions: SeenIdentityVersions,
    ) {
      for await (const { data } of orderedRows.range([new LinkValue(from), new LinkValue(to)])) {
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
