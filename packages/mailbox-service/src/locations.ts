import {
  type Identifier,
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
type Location = readonly [identifier: Identifier, at: number, service: Link<Signature>];

/**
 * The Services that the signatures a store holds sign, records or not, by
 * the identifier of the identity that signed each. A Service carries its authority
 * in the signature, so one that came in at a mailbox is honored as one
 * fetched.
 */
export interface Locations {
  /**
   * The links of the signatures over the Services of `identifier` that
   * `seenIdentityVersions` honor, from the latest back. One by a key that a
   * later identity version takes out is not honored, whatever its `at`.
   */
  servicesOf(identifier: Identifier, seenIdentityVersions: SeenIdentityVersions): Promise<Link<Signature>[]>;
}

export type LocationsView = View<Location, Locations>;

export function locationsView(signatures: Signatures, service: Schema<Json, ServiceData>): LocationsView {
  return {
    index: indexOverBlobs(signatures.selectionOver(service), async function* ({ signature, object }, reader) {
      // A row depends on the signature and its closure alone, so it is
      // verified by the identity version it carries; whether the signature
      // is honored is checked as the rows are read.
      const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
      yield [signedIdentity.identity.identifier, object.data.at, link];
    }),
    read: (rows, reader) => ({
      async servicesOf(identifier, seenIdentityVersions) {
        const links: Link<Signature>[] = [];
        for await (const [, , link] of rows.range([identifier])) {
          const signature = await signatures.read(link, reader, noIdentityVersions);
          if (await seenIdentityVersions.honors(signature)) links.unshift(link);
        }
        return links;
      },
    }),
  };
}
