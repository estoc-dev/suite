import type { Json, JsonLink } from "./json.ts";
import { DRAFT_2020_12, type JsonSchema, linkSchema } from "./json-schema.ts";
import type { Link } from "./link.ts";
import type { EncodedObject } from "./object.ts";

/**
 * The versions of one format, oldest first, as an object of its own. That a
 * schema is a later version of another is said apart from both, as a
 * signature is said of an object.
 *
 * - A lineage links to its versions, so they are in its closure. A schema links to none of its
 *   lineages.
 * - Anyone can write a lineage of anyone's schemas, and one schema can be on several.
 */
export interface Lineage<T> {
  readonly link: Link<Lineage<T>>;
  readonly versions: readonly Link<T>[];
}

/** The schema a lineage is written to in JSON. It lists at least one version, and each once. */
export const lineageSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Lineage",
  type: "object",
  properties: {
    versions: { type: "array", items: linkSchema, minItems: 1, uniqueItems: true },
  },
  required: ["versions"],
  additionalProperties: false,
};

export type LineageData<T> = { readonly versions: readonly JsonLink<T>[] };

/** The lineage that `object`, written to `lineageSchema`, lists. */
export function lineageOf<T>(object: EncodedObject<Json, LineageData<T>>): Lineage<T> {
  return { link: object.link as Link<never>, versions: object.data.versions.map(({ $link }) => $link) };
}
