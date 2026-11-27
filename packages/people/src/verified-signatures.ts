import { identityKit } from "@estoc/identity";
import { LinkValue, objectsOf, type Schema } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import {
  anyMemberObject,
  type HeldBlob,
  type Index,
  indexOver,
  linkedBlob,
  memberObjectOf,
  type Source,
} from "@estoc/store";

const { signatures } = identityKit;

const verifiedSignatureSchema = schema("Verified Signature", {
  identifier: link(),
  signature: link(),
  object: link(),
});

export type VerifiedSignatureData = DataOf<typeof verifiedSignatureSchema>;

const signatureObjects = objectsOf(signatures.schema);

/**
 * - A row of each Signature among the blobs that `source` gives, where the identity version it
 *   carries verifies it. One that does not verify fails, and so does one that does not fit its
 *   schema.
 * - A row says nothing of what is signed but its link, and nothing of whether the signature is
 *   honored: that depends on the identity versions a reader has seen.
 */
export function verifiedSignaturesOver(source: Source<HeldBlob>): Index<VerifiedSignatureData> {
  return indexOver(source, verifiedSignatureSchema, async function* ({ link }, reader) {
    const object = await signatureObjects.read(link, reader);
    if (object === undefined) return;
    const signature = await signatures.verify(object, reader);
    yield {
      identifier: new LinkValue(signature.signedIdentity.identity.identifier),
      signature: new LinkValue(signature.link),
      object: new LinkValue(signature.object),
    };
  });
}

const signature = memberObjectOf(signatures.schema);
const signedObjectSchema = schema("Signed Object", { signature: link(), object: link() });
const namedSchemaSchema = schema("Named Schema", { schema: link<Schema>() });

/**
 * - The verified signatures over the Signatures among the blobs that `source` gives that sign an
 *   object that names `schema`, whether the object fits it or not.
 * - A Signature that signs anything else is not verified, so the index does not fail on one that
 *   would not verify.
 */
export function verifiedSignaturesOf(schema: Schema, source: Source<HeldBlob>): Index<VerifiedSignatureData> {
  return verifiedSignaturesOver(
    source
      .rowsTaking(signedObjectSchema, { signature: signature.link, object: signature.field("object") })
      .rowsJoinedAt("object", linkedBlob.rowsTaking(namedSchemaSchema, { schema: anyMemberObject.schema }))
      .rowsWhere("schema", new LinkValue(schema.link))
      .linksAt("signature"),
  );
}
