import type {
  IdentityVersionData,
  IdentityVersionOrder,
  IdentityVersions,
  People,
  SeenIdentityVersions,
  Signature,
} from "@estoc/identity";
import { indexOver, selectedBlobs, type View } from "@estoc/store";

export type PeopleView = View<IdentityVersionData, IdentityVersionOrder, People>;

/**
 * A client's store can hold more than the service gave out, so it can have seen an identity version
 * that the service has not. The signatures that carry an identity version are not checked here
 * against the identity versions seen.
 */
export function peopleView(identityVersions: IdentityVersions): PeopleView {
  return {
    index: indexOver(
      selectedBlobs(identityVersions.selection),
      identityVersions.schema,
      identityVersions.rows,
    ).orderedBy(...identityVersions.order),
    read: (rows, reader) => identityVersions.people(rows, reader),
  };
}

export async function checkHonors(seenIdentityVersions: SeenIdentityVersions, signature: Signature): Promise<void> {
  if (await seenIdentityVersions.honors(signature)) return;
  const { key, signedIdentity } = signature;
  throw new Error(
    `the signature by ${key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
  );
}
