import type { Signature, Signatures } from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import type { SeenIdentityVersions } from "@estoc/people";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { indexOver, selectedBlobs, type View } from "@estoc/store";
import { serviceSchema } from "./schemas.ts";

const locationSchema = schema("Location", {
  identifier: link(),
  at: integer(),
  service: link(),
});

/**
 * The signature comes after `at`, so that of two Services at the same `at`,
 * as services started at once on one store can sign, every store takes the
 * same one for the latest, whatever order it took them in.
 */
type LocationOrder = readonly ["identifier", "at", "service"];

/**
 * A Service carries its authority in the signature, so one that came in at a mailbox is honored as
 * one fetched.
 */
export interface Locations {
  servicesOf(identifier: Link<unknown>, seenIdentityVersions: SeenIdentityVersions): Promise<Signature[]>;
}

export type LocationsView = View<DataOf<typeof locationSchema>, LocationOrder, Locations>;

export function locationsView(signatures: Signatures): LocationsView {
  return {
    index: indexOver(
      selectedBlobs(signatures.selectionOver(serviceSchema)),
      locationSchema,
      ({ signature, object }) => [
        {
          identifier: new LinkValue(signature.signedIdentity.identity.identifier),
          at: object.data.at,
          service: new LinkValue(signature.link),
        },
      ],
    ).orderedBy("identifier", "at", "service"),
    read: (rows, reader) => ({
      async servicesOf(identifier, seenIdentityVersions) {
        const services: Signature[] = [];
        for await (const { data } of rows.range([new LinkValue(identifier)])) {
          const signature = await signatures.read(data.service.link, reader);
          if (await seenIdentityVersions.honors(signature)) services.unshift(signature);
        }
        return services;
      },
    }),
  };
}
