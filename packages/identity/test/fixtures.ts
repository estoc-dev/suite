import { type Link, linkOf, type ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import {
  type CurveScheme,
  ed25519,
  eip191,
  type IdentityVersionRows,
  type IdentityVersions,
  type SignedIdentityObject,
  solanaOffchain,
} from "../src/index.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

/** What is read from an object and carries the blobs to read it again, as a key or a signature is. */
interface Carrying {
  readonly link: Link<unknown>;
  readonly blobs: readonly Uint8Array[];
}

/** The bytes of the object that `read` is read from, which its blobs hold. */
export function bytesOf({ link, blobs }: Carrying): Uint8Array {
  const bytes = blobs.find((each) => linkOf(each) === link);
  if (bytes === undefined) throw new Error(`the blobs of ${link} do not hold it`);
  return bytes;
}

/** The data of the object that `read` is read from, as the object format decodes it. */
export const dataOf = (read: Carrying): ValueMap => objectFormat.decode(bytesOf(read)).data;

/** The link of the schema that the object `read` is read from is written to. */
export function schemaLinkOf(read: Carrying): Link<unknown> {
  const { schema } = objectFormat.decode(bytesOf(read));
  return typeof schema === "string" ? schema : read.link;
}

// The closure a store gathers from a blob: the blob and every blob reached by
// the links the object format finds in it, past which a blob that is not an object links to nothing.
export function closure(link: Link<unknown>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Set<Link<unknown>> {
  const reached = new Set([link]);
  for (const next of reached) {
    const bytes = blobs.get(next);
    if (bytes === undefined) continue;
    let value: ObjectValue;
    try {
      value = objectFormat.decode(bytes);
    } catch {
      continue;
    }
    for (const linked of objectFormat.links(value)) reached.add(linked);
  }
  return reached;
}

/**
 * The rows of the identity versions `signedIdentities` are, and those they
 * follow, in the order of an index of them, as an index of a store that holds them
 * gives them.
 */
export function rowsOf(
  identityVersions: IdentityVersions,
  ...signedIdentities: readonly SignedIdentityObject[]
): IdentityVersionRows {
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
