import { type Link, LinkValue, type Schema } from "@estoc/object";
import { type DataOf, integer, link, schema } from "@estoc/schema";
import { anyMemberObject, memberObjectOf } from "./definition.ts";
import { inboundSchema } from "./inbound.ts";
import { indexOfRows, recordedStatements } from "./source.ts";
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

const inbound = memberObjectOf(inboundSchema);
const writtenObject = memberObjectOf(writtenObjectSchema);

// A root has a row whatever it is.
const rootArrivals = indexOfRows(arrivalSchema, { object: inbound.field("bundle"), at: inbound.field("at") })
  .reading(recordedStatements)
  .union(
    indexOfRows(arrivalSchema, { object: writtenObject.field("object"), at: writtenObject.field("at") }).reading(
      recordedStatements,
    ),
  );

const namedSchemaRow = schema("Named Schema", { schema: link<Schema>() });

const closureArrivals = rootArrivals
  .rowsOfEachInClosureAt("object")
  .rowsJoinedAt("object", indexOfRows(namedSchemaRow, { schema: anyMemberObject.schema }));

/**
 * - Where a store keeps a blob says nothing here, so the same bytes sent by someone else change no
 *   time unless they are recorded as coming in.
 * - What a closure holds is told by the schema it names, so an object that names `schema` and does
 *   not fit it has a time as well, as a root has whatever it is.
 */
export function arrivalsView(schema: Schema): ArrivalsView {
  const arrivalsOfSchema = closureArrivals.rowsWhere("schema", new LinkValue(schema.link));
  const arrival = memberObjectOf(arrivalsOfSchema.rowSchema);
  return {
    index: rootArrivals.union(
      indexOfRows(arrivalSchema, { object: arrival.field("object"), at: arrival.field("at") }).reading(
        arrivalsOfSchema,
      ),
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
