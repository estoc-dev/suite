import type { IdentityVersionData, IdentityVersionOrder, IdentityVersions, People } from "@estoc/identity";
import { indexOver, selectedBlobs, type View } from "@estoc/store";

export type PeopleView = View<IdentityVersionData, IdentityVersionOrder, People>;

/**
 * The people of a service's store, or of a client's of it, by the signed
 * identities the store holds, wherever they sit in a closure it holds.
 *
 * - A client's store can hold more than the service gave out, so it can
 *   have seen an identity version that the service has not.
 * - Each identity version's root signature is verified; the signatures that
 *   carry it are not checked here against the identity versions seen.
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
