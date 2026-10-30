import type { Link } from "@estoc/object";
import {
  ed25519,
  eip191,
  type KeyObject,
  type Scheme,
  type SignedIdentityObject,
  solanaOffchain,
  type Version,
  versionOf,
} from "../src/index.ts";

export const schemes: readonly Scheme[] = [ed25519, eip191, solanaOffchain];

/** The rows of the versions `signedIdentities` are, in the order of their keys, as an index of a store gives them. */
export function rowsOf(...signedIdentities: readonly SignedIdentityObject[]) {
  const rows = signedIdentities.map((signedIdentity) => versionOf(signedIdentity)).filter((row) => row !== undefined);
  rows.sort(
    ([, at, link], [, otherAt, otherLink]) => at - otherAt || (link < otherLink ? -1 : link > otherLink ? 1 : 0),
  );
  return {
    async *range([root]: readonly [Link<KeyObject>]): AsyncIterable<Version> {
      yield* rows.filter(([of]) => of === root);
    },
  };
}
