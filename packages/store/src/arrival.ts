import { type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { closureIn } from "./batch.ts";
import { inboundSchema } from "./inbound.ts";
import { recordSchema } from "./record.ts";
import { namedSchemaOf } from "./scanned-blob.ts";
import { indexOver, selectedMarks } from "./source.ts";
import type { View } from "./view.ts";

/**
 * `at` is the `at` of the mark, in milliseconds since the Unix epoch, by the clock of the device
 * that wrote the mark.
 */
export const arrivalSchema = schema("Arrival", { object: link(), at: integer() });

export type ArrivalData = DataOf<typeof arrivalSchema>;

export type ArrivalOrder = readonly ["object", "at"];

export interface Arrivals {
  atOf(link: Link<unknown>): Promise<number | undefined>;
}

export type ArrivalsView = View<ArrivalData, ArrivalOrder, Arrivals>;

/**
 * - A mark says when each object of `schema` in the closure of its root came, and no other blob, so
 *   an object that came inside what someone else signed has no time of its own.
 * - Where a store keeps a blob says nothing here, so the same bytes sent by someone else change no
 *   time unless they are marked as coming in.
 * - The closure of each root is read once for its mark, so blobs that many closures share are read
 *   once for each.
 */
export function arrivalsView(schema: { readonly link: Link<unknown> }): ArrivalsView {
  async function* arrivalsOf(root: Link<unknown>, at: number, reader: Reader): AsyncIterable<ArrivalData> {
    yield { object: new LinkValue(root), at };
    for (const [blob, bytes] of await closureIn(reader, root))
      if (blob !== root && namedSchemaOf(bytes) === schema.link) yield { object: new LinkValue(blob), at };
  }
  const arrivalsOfBundles = indexOver(selectedMarks(objectsOf(inboundSchema)), arrivalSchema, ({ data }, reader) =>
    arrivalsOf(data.bundle.link, data.at, reader),
  );
  const arrivalsOfRecordedObjects = indexOver(
    selectedMarks(objectsOf(recordSchema)),
    arrivalSchema,
    ({ data }, reader) => arrivalsOf(data.object.link, data.at, reader),
  );
  return {
    index: arrivalsOfBundles.union(arrivalsOfRecordedObjects).orderedBy("object", "at"),
    read: (rows) => ({
      async atOf(link) {
        for await (const { data } of rows.range([new LinkValue(link)])) return data.at;
        return undefined;
      },
    }),
  };
}
