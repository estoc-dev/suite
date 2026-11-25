import type { EncodedObject, LinkValue, Schema } from "@estoc/object";
import { link, schema } from "@estoc/schema";

/**
 * A list that every runtime has. Each row is a pair of links, and the rows are sorted by the fields
 * of `order`, so the rows under a link are those that hold it in the first of them.
 */
export interface PairList<First extends string, Second extends string> {
  readonly name: string;
  readonly rowSchema: Schema<{ readonly [Field in First | Second]: LinkValue<unknown> }>;
  readonly order: readonly [First, Second];
}

/** The rows under a schema are the objects held that are written to it. */
export const heldObjects: PairList<"schema", "object"> = {
  name: "Schemas",
  rowSchema: schema("Held Object", { schema: link<Schema>(), object: link<EncodedObject>() }),
  order: ["schema", "object"],
};

/**
 * The rows under a blob are what links to it. A `source` that gives its schema by a link to
 * `target` is a row here as well as in Schemas.
 */
export const heldLinks: PairList<"target", "source"> = {
  name: "Links",
  rowSchema: schema("Held Link", { target: link(), source: link<EncodedObject>() }),
  order: ["target", "source"],
};
