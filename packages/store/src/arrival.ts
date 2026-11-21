import { type Link, LinkValue, objectsOf, type Reader } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { closureIn } from "./batch.ts";
import { inboundSchema } from "./inbound.ts";
import { namedSchemaOf } from "./scanned-blob.ts";
import { indexOver, selectedRecords } from "./source.ts";
import type { View } from "./view.ts";
import { writtenObjectSchema } from "./written-object.ts";

/**
 * `at` is the `at` of the Inbound or Written Object, in milliseconds since the Unix epoch, by the
 * clock of the device that recorded it.
 */
export const arrivalSchema = schema("Arrival", { object: link(), at: integer() });

export type ArrivalData = DataOf<typeof arrivalSchema>;

export type ArrivalOrder = readonly ["object", "at"];

export interface Arrivals {
  atOf(link: Link<unknown>): Promise<number | undefined>;
}

export type ArrivalsView = View<ArrivalData, ArrivalOrder, Arrivals>;

/**
 * - Where a store keeps a blob says nothing here, so the same bytes sent by someone else change no
 *   time unless they are recorded as coming in.
 * - The closure of each root is read once for its record, so blobs that many closures share are
 *   read once for each.
 */
export function arrivalsView(schema: { readonly link: Link<unknown> }): ArrivalsView {
  async function* arrivalsOf(root: Link<unknown>, at: number, reader: Reader): AsyncIterable<ArrivalData> {
    yield { object: new LinkValue(root), at };
    for (const [blob, bytes] of await closureIn(reader, root))
      if (blob !== root && namedSchemaOf(bytes) === schema.link) yield { object: new LinkValue(blob), at };
  }
  const arrivalsOfBundles = indexOver(selectedRecords(objectsOf(inboundSchema)), arrivalSchema, ({ data }, reader) =>
    arrivalsOf(data.bundle.link, data.at, reader),
  );
  const arrivalsOfWrittenObjects = indexOver(
    selectedRecords(objectsOf(writtenObjectSchema)),
    arrivalSchema,
    ({ data }, reader) => arrivalsOf(data.object.link, data.at, reader),
  );
  return {
    index: arrivalsOfBundles.union(arrivalsOfWrittenObjects).orderedBy("object", "at"),
    read: (rows) => ({
      async atOf(link) {
        for await (const { data } of rows.range([new LinkValue(link)])) return data.at;
        return undefined;
      },
    }),
  };
}
