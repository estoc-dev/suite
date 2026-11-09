import {
  hasSigner,
  type KeyObject,
  noIdentityVersions,
  type SeenIdentityVersions,
  type Signature,
  type Signatures,
} from "@estoc/identity";
import type { Json, Link, Schema } from "@estoc/object";
import { indexOverBlobs, type View } from "@estoc/store";
import type { ServiceData } from "./schemas.ts";

/**
 * The signature's link comes after `at`, so that of two Services at the same
 * `at`, as services started at once on one store can sign, every store takes
 * the same one for the latest, whatever order it took them in.
 */
type Location = readonly [root: Link<KeyObject>, at: number, service: Link<Signature>];

/**
 * The Services that the signatures a store holds sign, records or not, by
 * the root of the identity that signed each. A Service carries its authority
 * in the signature, so one that came in at a mailbox counts as one fetched.
 */
export interface Locations {
  /**
   * The links of the signatures over the Services of `root` whose keys sign
   * for the current identity version that `seenIdentityVersions` gives, from
   * the latest back. One by a key that a later identity version takes out
   * does not count, whatever its `at`.
   */
  servicesOf(root: Link<KeyObject>, seenIdentityVersions: SeenIdentityVersions): Promise<Link<Signature>[]>;
}

export type LocationsView = View<Location, Locations>;

export function locationsView(signatures: Signatures, service: Schema<Json, ServiceData>): LocationsView {
  return {
    index: indexOverBlobs(signatures.selectionOver(service), async function* ({ signature, object }, reader) {
      // A row depends on the signature and its closure alone, so it is
      // verified by the identity version it carries; whether that identity
      // version still counts is checked as the rows are read.
      const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
      yield [signedIdentity.identity.root.link, object.data.at, link];
    }),
    read: (rows, reader) => ({
      async servicesOf(root, seenIdentityVersions) {
        const links: Link<Signature>[] = [];
        for await (const [, , link] of rows.range([root])) {
          const { signedIdentity, key } = await signatures.read(link, reader, noIdentityVersions);
          const current = await seenIdentityVersions.current(signedIdentity);
          if (hasSigner(current.identity, key)) links.unshift(link);
        }
        return links;
      },
    }),
  };
}
