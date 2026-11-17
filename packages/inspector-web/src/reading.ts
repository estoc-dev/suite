import { bodies } from "@estoc/blog";
import type { Inspection } from "@estoc/inspector";
import { decodeObject, type EncodedObject, type Link, type Reader, type Schema, type ValueMap } from "@estoc/object";

/** What the page makes of an object beyond its fields: markup the page wrote itself. */
export interface Reading {
  readonly html: string;
}

/**
 * What the page makes of what a link reads as, where it is an object of a schema the page reads.
 * The schemas it reads are the body schemas of a post.
 *
 * - A schema is matched by its link and not by its title. The page holds the schema, so the
 *   object is read whether or not the reader gives the blob of its schema.
 * - Nothing for an object of any other schema, or for one whose data does not fit its schema.
 */
export async function readingOf(inspection: Inspection, reader: Reader): Promise<Reading | undefined> {
  if (inspection.kind !== "object") return undefined;
  const implementation = bodies.implementationOf(inspection.schema.link as Link<Schema>);
  if (implementation === undefined) return undefined;
  const object = fittingObject(inspection.bytes, implementation.schema);
  return object && implementation.read(object, reader);
}

function fittingObject<F extends ValueMap>(bytes: Uint8Array, schema: Schema<F>): EncodedObject<F> | undefined {
  try {
    return decodeObject(bytes, schema);
  } catch {
    return undefined;
  }
}
