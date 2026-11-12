import {
  type Identifier,
  type KeyObject,
  noIdentityVersions,
  type SeenIdentityVersions,
  type Signature,
  type Signatures,
} from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { indexOver, selectedBlobs, type View } from "@estoc/store";
import { serviceSchema } from "./schemas.ts";

/**
 * The schema of a signed Service as a row of an index: the identifier of the
 * identity that signed it, its `at`, and the signature.
 */
const locationSchema = schema("Location", {
  identifier: link<KeyObject>(),
  at: integer(),
  service: link<Signature>(),
});

/**
 * The signature comes after `at`, so that of two Services at the same `at`,
 * as services started at once on one store can sign, every store takes the
 * same one for the latest, whatever order it took them in.
 */
type LocationOrder = readonly ["identifier", "at", "service"];

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

export type LocationsView = View<DataOf<typeof locationSchema>, LocationOrder, Locations>;

export function locationsView(signatures: Signatures): LocationsView {
  return {
    index: indexOver(
      selectedBlobs(signatures.selectionOver(serviceSchema)),
      locationSchema,
      async function* ({ signature, object }, reader) {
        // A row depends on the signature and its closure alone, so it is
        // verified by the identity version it carries; whether the signature
        // is honored is checked as the rows are read.
        const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
        yield {
          identifier: new LinkValue(signedIdentity.identity.identifier),
          at: object.data.at,
          service: new LinkValue(link),
        };
      },
    ).orderedBy("identifier", "at", "service"),
    read: (rows, reader) => ({
      async servicesOf(identifier, seenIdentityVersions) {
        const links: Link<Signature>[] = [];
        for await (const { data } of rows.range([new LinkValue(identifier)])) {
          const signature = await signatures.read(data.service.link, reader, noIdentityVersions);
          if (await seenIdentityVersions.honors(signature)) links.unshift(data.service.link);
        }
        return links;
      },
    }),
  };
}
