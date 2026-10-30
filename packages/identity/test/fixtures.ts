import type { Link } from "@estoc/object";
import { type KeyObject, type SignedIdentityObject, type Version, versionOf } from "../src/index.ts";

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
