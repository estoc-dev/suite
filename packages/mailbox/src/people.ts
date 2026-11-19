import type { IdentityVersionData, IdentityVersionOrder, IdentityVersions, People } from "@estoc/identity";
import { indexOver, selectedBlobs, type View } from "@estoc/store";

export type PeopleView = View<IdentityVersionData, IdentityVersionOrder, People>;

/**
 * A store holds what came to it from anywhere, so it can have seen an identity version that those
 * it corresponds with have not. The signatures that carry an identity version are not checked here
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
