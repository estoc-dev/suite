import { identityKit } from "@estoc/identity";
import { LinkValue, objectsOf } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { type HeldBlob, heldObjectsOf, type Index, indexOver, type Source } from "@estoc/store";

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
 *   carries verifies it. One that does not verify is a failure on the Signature, and so is one that
 *   does not fit its schema.
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

/** Those among the blobs read, wherever they came from: a signature carries its authority itself. */
export const verifiedSignatures = verifiedSignaturesOver(heldObjectsOf(signatures.schema));
