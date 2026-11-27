import { identityKit, type Signature } from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import { type SeenIdentityVersions, verifiedSignatures } from "@estoc/people";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { linkedBlob, memberObjectOf, type View } from "@estoc/store";
import { serviceSchema } from "./schemas.ts";

const { signatures } = identityKit;

const locationSchema = schema("Location", {
  identifier: link(),
  at: integer(),
  service: link(),
});

const serviceTimeSchema = schema("Service Time", { at: integer() });

const signedServices = verifiedSignatures.rowsJoinedAt(
  "object",
  linkedBlob.rowsTaking(serviceTimeSchema, { at: memberObjectOf(serviceSchema).field("at") }),
);

const signedService = memberObjectOf(signedServices.rowSchema);

export const locations = signedServices.rowsTaking(locationSchema, {
  identifier: signedService.field("identifier"),
  at: signedService.field("at"),
  service: signedService.field("signature"),
});

/**
 * A Service carries its authority in the signature, so one that came in at a mailbox is honored as
 * one fetched.
 */
export interface Locations {
  servicesOf(identifier: Link<unknown>, seenIdentityVersions: SeenIdentityVersions): Promise<Signature[]>;
}

export const locationsView: View<DataOf<typeof locations.rowSchema>, Locations> = {
  index: locations,
  read: (rows, reader) => {
    // The signature comes after `at`, so that of two Services at the same `at`, as services started
    // at once on one store can sign, every store takes the same one for the latest, whatever order
    // it took them in.
    const orderedRows = rows.orderedBy("identifier", "at", "service");
    return {
      async servicesOf(identifier, seenIdentityVersions) {
        const services: Signature[] = [];
        for await (const { data } of orderedRows.range([new LinkValue(identifier)])) {
          const signature = await signatures.read(data.service.link, reader);
          if (await seenIdentityVersions.honors(signature)) services.unshift(signature);
        }
        return services;
      },
    };
  },
};
