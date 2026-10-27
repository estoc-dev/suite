import {
  decodeObject,
  type IdentityObject,
  type Json,
  json,
  type Link,
  type Schema,
  type Signature,
  type SignatureData,
  type Signatures,
  schemaOf,
} from "@estoc/object";
import { type Index, type Store, scan } from "@estoc/store";
import type { ServiceData } from "./schemas.ts";

/** A row of a Service's signature: the identity that signed it, its `at`, and its link. */
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
      yield [identity.link, decodeObject(bytes, service).data.at, link];
    },
  };
}

/**
 * The links of the signatures over the Services of `identity` that `store`
 * holds as mine, from the latest `at` back.
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
