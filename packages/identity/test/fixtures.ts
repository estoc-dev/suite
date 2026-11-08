import { type Json, json, type Link, linkOf } from "@estoc/object";
import {
  type CurveScheme,
  ed25519,
  eip191,
  type IdentityVersions,
  type KeyObject,
  type SignedIdentityObject,
  solanaOffchain,
  type Version,
} from "../src/index.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

// The closure a store gathers from a blob: the blob and every blob reached by
// the links JSON finds in it, past which a blob that is not an object links to nothing.
export function closure(link: Link<unknown>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Set<Link<unknown>> {
  const reached = new Set([link]);
  for (const next of reached) {
    const bytes = blobs.get(next);
    if (bytes === undefined) continue;
    let value: Json;
    try {
      value = json.decode(bytes);
    } catch {
      continue;
    }
    for (const linked of json.links(value)) reached.add(linked);
  }
  return reached;
}

/** The rows of the versions `signedIdentities` are, in the order of their keys, as an index of a store gives them. */
export function rowsOf(versions: IdentityVersions, ...signedIdentities: readonly SignedIdentityObject[]) {
  const rows = signedIdentities.map((signedIdentity) => versions.versionOf(signedIdentity));
  rows.sort(
    ([, at, link], [, otherAt, otherLink]) => at - otherAt || (link < otherLink ? -1 : link > otherLink ? 1 : 0),
  );
  return {
    async *range([root]: readonly [Link<KeyObject>]): AsyncIterable<Version> {
      yield* rows.filter(([of]) => of === root);
    },
  };
}
