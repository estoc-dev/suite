import { type KeyObject, noVersions, type Signature, type Signatures } from "@estoc/identity";
import { decodeObject, type Json, json, type Link, objectsOf, type Schema, schemaOf } from "@estoc/object";
import { indexOver, type View } from "@estoc/store";
import type { ServiceData } from "./schemas.ts";

/**
 * The signature's link comes after `at`, so that of two Services at the same
 * `at`, as services started at once on one store can sign, every store takes
 * the same one for the latest, whatever order it took them in.
 */
type Location = readonly [root: Link<KeyObject>, at: number, service: Link<Signature>];

/** The Services that recorded signatures sign, by the root of the identity that signed each. */
export interface Locations {
  /** The links of the signatures over the Services of `root`, from the latest back. */
  servicesOf(root: Link<KeyObject>): Promise<Link<Signature>[]>;
}

export type LocationsView = View<Json, Location, Locations>;

export function locationsView(signatures: Signatures, service: Schema<Json, ServiceData>): LocationsView {
  return {
    index: indexOver(objectsOf(signatures.schema), async function* (signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== service.link) return;
      // A row depends on the signature and its closure alone, so it is
      // verified by the version it carries; whether that version still
      // counts is for whoever reads the Service to check.
      const { signedIdentity, link } = await signatures.verify(signature, reader, noVersions);
      yield [signedIdentity.identity.root.link, decodeObject(bytes, service).data.at, link];
    }),
    read: (rows) => ({
      async servicesOf(root) {
        const links: Link<Signature>[] = [];
        for await (const [, , link] of rows.range([root])) links.unshift(link);
        return links;
      },
    }),
  };
}
