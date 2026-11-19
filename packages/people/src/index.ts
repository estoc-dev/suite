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
 * A store takes in identity versions from anyone it corresponds with. One that its root signed
 * gives a row whether or not a signature that carries it is honored.
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
