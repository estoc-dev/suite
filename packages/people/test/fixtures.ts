import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  type SignedIdentityObject,
  SoftwareSigner,
  solanaOffchain,
} from "@estoc/identity";
import { type Link, linkOf } from "@estoc/object";
import { type IdentityVersionRows, IdentityVersions } from "../src/identity-versions.ts";
import type { People } from "../src/index.ts";

export const { keys, signatures, signedIdentities, publish } = loadIdentity([ed25519, eip191, solanaOffchain]);
export const identityVersions = new IdentityVersions(signedIdentities);

export const signer = (scheme: CurveScheme, fill = 1) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
export const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
export const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));
/** Given to an actor as what is current, so that it signs by the identity version it is made with. */
export const identityVersionInHand = async <T>(inHand: T) => inHand;

export function bytesOf({ link, blobs }: SignedIdentityObject): Uint8Array {
  const bytes = blobs.find((each) => linkOf(each) === link);
  if (bytes === undefined) throw new Error(`the blobs of ${link} do not hold it`);
  return bytes;
}

/**
 * The rows of the identity versions `signedIdentities` are, and those they
 * follow, in the order of an index of them, as an index of a store that holds them
 * gives them.
 */
function rowsOf(...signedIdentities: readonly SignedIdentityObject[]): IdentityVersionRows {
  const signedIdentitiesByLink = new Map<Link<unknown>, SignedIdentityObject>();
  for (const signedIdentity of signedIdentities) {
    for (let each: SignedIdentityObject | undefined = signedIdentity; each !== undefined; each = each.identity.prior) {
      signedIdentitiesByLink.set(each.link, each);
    }
  }
  const rows = [...signedIdentitiesByLink.values()].map((signedIdentity) =>
    identityVersions.identityVersionOf(signedIdentity),
  );
  const versionLinkOf = ({ signedIdentity }: (typeof rows)[number]) => signedIdentity.link;
  rows.sort(
    (a, b) => a.at - b.at || (versionLinkOf(a) < versionLinkOf(b) ? -1 : versionLinkOf(a) > versionLinkOf(b) ? 1 : 0),
  );
  return {
    async *range([root]) {
      yield* rows.filter(({ identifier }) => identifier.link === root.link).map((data) => ({ data }));
    },
  };
}

export const peopleHavingSeen = (...versions: readonly SignedIdentityObject[]): People =>
  identityVersions.people(rowsOf(...versions), byLink(versions.flatMap(({ blobs }) => blobs)));
