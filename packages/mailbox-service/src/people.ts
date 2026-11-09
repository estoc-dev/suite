import type { IdentityVersion, IdentityVersions, People } from "@estoc/identity";
import { indexOverBlobs, type View } from "@estoc/store";

export type PeopleView = View<IdentityVersion, People>;

/**
 * The people of a service's store, or of a client's of it, by the signed
 * identities the store holds, wherever they sit in the closure of a record.
 *
 * - A client's store can hold other records than the service gave out, so it
 *   can have seen an identity version that the service has not.
 * - Each identity version's root signature is verified; the signatures that
 *   carry it are not checked here against the identity versions seen.
 */
export function peopleView(identityVersions: IdentityVersions): PeopleView {
  return {
    index: indexOverBlobs(identityVersions.selection, (identityVersion) => [identityVersion]),
    read: (rows, reader) => identityVersions.people(rows, reader),
  };
}
