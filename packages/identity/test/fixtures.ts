import { type Est, est, type Link, linkOf } from "@estoc/object";
import {
  type CurveScheme,
  ed25519,
  eip191,
  type IdentityVersionRows,
  type IdentityVersions,
  type SignedIdentityObject,
  type StoreReader,
  solanaOffchain,
} from "../src/index.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

/** A reader of `blobs` as a store that took them in in the order given, each the first time. */
export function storeOf(blobs: readonly Uint8Array[]): StoreReader {
  const held = new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
  const positions = new Map([...held.keys()].map((link, position) => [link, position]));
  return { get: (link) => held.get(link), positionOf: (link) => positions.get(link) };
}

// The closure a store gathers from a blob: the blob and every blob reached by
// the links est finds in it, past which a blob that is not an object links to nothing.
export function closure(link: Link<unknown>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Set<Link<unknown>> {
  const reached = new Set([link]);
  for (const next of reached) {
    const bytes = blobs.get(next);
    if (bytes === undefined) continue;
    let value: Est;
    try {
      value = est.decode(bytes);
    } catch {
      continue;
    }
    for (const linked of est.links(value)) reached.add(linked);
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
  const held = new Map<Link<SignedIdentityObject>, SignedIdentityObject>();
  for (const signedIdentity of signedIdentities) {
    for (let each: SignedIdentityObject | undefined = signedIdentity; each !== undefined; each = each.identity.prior) {
      held.set(each.link, each);
    }
  }
  const rows = [...held.values()].map((signedIdentity) => identityVersions.identityVersionOf(signedIdentity));
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
