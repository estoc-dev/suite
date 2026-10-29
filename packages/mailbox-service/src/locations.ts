import type { IdentityObject, Signature, SignatureData, Signatures } from "@estoc/identity";
import { decodeObject, type Json, json, type Link, type Schema, schemaOf } from "@estoc/object";
import { type Index, type Store, scan } from "@estoc/store";
import type { ServiceData } from "./schemas.ts";

/**
 * The signature's link comes after `at`, so that of two Services at the same
 * `at`, as services started at once on one store can sign, every store takes
 * the same one for the latest, whatever order it took them in.
 */
type Location = readonly [identity: Link<IdentityObject>, at: number, service: Link<Signature>];

export type Locations = Index<Json, Location, SignatureData>;

/** The Services that the signatures written as mine sign, by the identity that signed each. */
export function locations(signatures: Signatures, service: Schema<Json, ServiceData>): Locations {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== service.link) return;
      const { identity, link } = await signatures.verify(signature, reader);
      yield [identity.identity.link, decodeObject(bytes, service).data.at, link];
    },
  };
}

/**
 * The links of the signatures over the Services of `identity` that `store`
 * holds as mine, from the latest back.
 */
export async function servicesOf(
  store: Store,
  locations: Locations,
  identity: Link<IdentityObject>,
): Promise<Link<Signature>[]> {
  const links: Link<Signature>[] = [];
  for await (const [, , link] of (await scan(store, locations)).range([identity])) links.unshift(link);
  return links;
}
