import { type Body, bodies } from "@estoc/blog";
import type { Inspection } from "@estoc/inspector";
import { decodeObject, type Link, type Reader, type Schema } from "@estoc/object";

/** What the page reads an object as, or why it could not read an object of a schema it reads. */
export type Reading =
  | { readonly kind: "read"; readonly body: Body }
  | { readonly kind: "unread"; readonly error: unknown };

/**
 * The page's reading of what a link reads as. The schemas the page reads are the body schemas of a post.
 *
 * - A schema is matched by its link and not by its title. The page holds the schema, so the
 *   object is read whether or not the reader gives the blob of its schema.
 * - Nothing for an object of any other schema.
 * - What stops the reading is given and not thrown, as where the data does not fit the schema.
 */
export async function readingOf(inspection: Inspection, reader: Reader): Promise<Reading | undefined> {
  if (inspection.kind !== "object") return undefined;
  const implementation = bodies.implementationOf(inspection.schema.link as Link<Schema>);
  if (implementation === undefined) return undefined;
  try {
    const object = decodeObject(inspection.bytes, implementation.schema);
    return { kind: "read", body: await implementation.read(object, reader) };
  } catch (error) {
    return { kind: "unread", error };
  }
}
