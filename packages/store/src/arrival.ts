import { type Link, LinkValue, type Schema } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { recordedStatement, type ValuePath } from "./definition.ts";
import { inboundSchema } from "./inbound.ts";
import { indexOfRows } from "./source.ts";
import type { View } from "./view.ts";
import { writtenObjectSchema } from "./written-object.ts";

/**
 * `at` is the `at` of the Inbound or Written Object, in milliseconds since the Unix epoch, by the
 * clock of the device that recorded it.
 */
export const arrivalSchema = schema("Arrival", { object: link(), at: integer() });

export type ArrivalData = DataOf<typeof arrivalSchema>;

export interface Arrivals {
  atOf(link: Link<unknown>): Promise<number | undefined>;
}

export type ArrivalsView = View<ArrivalData, Arrivals>;

/**
 * - Where a store keeps a blob says nothing here, so the same bytes sent by someone else change no
 *   time unless they are recorded as coming in.
 * - The closure of each root is read once for its record, so blobs that many closures share are
 *   read once for each.
 */
export function arrivalsView(schema: Schema): ArrivalsView {
  // The root has a row whatever it is, and a root of `schema` has the same row of both parts.
  const arrivalsOf = (root: ValuePath<LinkValue<unknown>>, at: ValuePath<number>) =>
    indexOfRows(arrivalSchema, { object: root, at }).union(
      indexOfRows(arrivalSchema, { object: root.eachInClosure().objectOf(schema).link, at }),
    );
  const inbound = recordedStatement(inboundSchema);
  const writtenObject = recordedStatement(writtenObjectSchema);
  return {
    index: arrivalsOf(inbound.field("bundle"), inbound.field("at")).union(
      arrivalsOf(writtenObject.field("object"), writtenObject.field("at")),
    ),
    read: (rows) => {
      const orderedRows = rows.orderedBy("object", "at");
      return {
        async atOf(link) {
          for await (const { data } of orderedRows.range([new LinkValue(link)])) return data.at;
          return undefined;
        },
      };
    },
  };
}
