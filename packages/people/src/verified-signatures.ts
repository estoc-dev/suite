import { identityKit } from "@estoc/identity";
import { LinkValue, readObjectNaming, type Schema } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { anyMemberObject, type Collection, type Index, indexOver, linkedBlob, memberObjectOf } from "@estoc/store";

const { signatures } = identityKit;

const verifiedSignatureSchema = schema("Verified Signature", {
  identifier: link(),
  signature: link(),
  object: link(),
});

export type VerifiedSignatureData = DataOf<typeof verifiedSignatureSchema>;

/**
 * - A row of each Signature among the blobs that `collection` gives, where the identity version it
 *   carries verifies it. One that does not verify fails, and so does one that does not fit its
 *   schema.
 * - A row says nothing of what is signed but its link, and nothing of whether the signature is
 *   honored: that depends on the identity versions a reader has seen.
 */
export function verifiedSignaturesOver(collection: Collection): Index<VerifiedSignatureData> {
  return indexOver(collection, verifiedSignatureSchema, async function* ({ link }, reader) {
    const object = await readObjectNaming(reader, link, signatures.schema);
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
 * - The verified signatures over the Signatures among the blobs that `collection` gives that sign an
 *   object that names `schema`, whether the object fits it or not.
 * - A Signature that signs anything else is not verified, so the index does not fail on one that
 *   would not verify.
 */
export function verifiedSignaturesOf(schema: Schema, collection: Collection): Index<VerifiedSignatureData> {
  return verifiedSignaturesOver(
    collection
      .rowsTaking(signedObjectSchema, { signature: signature.link, object: signature.field("object") })
      .rowsJoinedAt("object", linkedBlob.rowsTaking(namedSchemaSchema, { schema: anyMemberObject.schema }))
      .rowsWhere("schema", new LinkValue(schema.link))
      .linksAt("signature"),
  );
}
