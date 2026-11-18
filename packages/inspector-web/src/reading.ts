import type { Inspection } from "@estoc/inspector";
import { decodeObject, type Implementations, type Link, type Reader, type Schema } from "@estoc/object";
import type { Child } from "./dom.ts";

/**
 * One thing the page reads objects as, such as a signature.
 *
 * Each draws what it read itself, so what two of them read objects as need not have one shape.
 */
export interface ReadingAs<T> {
  /** What a title calls it, as `a signature` in "Read by this page as a signature". */
  readonly name: string;
  /** The schemas whose objects the page reads as it, each with how. */
  readonly implementations: Implementations<T>;
  viewOf(value: T): Child;
}

/** What the page reads an object as, or why it could not read an object of a schema it reads. */
export type Reading<T = unknown> =
  | { readonly kind: "read"; readonly as: ReadingAs<T>; readonly value: T }
  | { readonly kind: "unread"; readonly as: ReadingAs<T>; readonly error: unknown };

/**
 * The page's reading of what a link reads as, by the one of `readings` that reads its schema.
 *
 * - A schema is matched by its link and not by its title. The page holds the schema, so the
 *   object is read whether or not the reader gives the blob of its schema.
 * - Nothing for an object of a schema that none of `readings` reads.
 * - What stops the reading is given and not thrown, as where the data does not fit the schema, or
 *   the reader gives no blob for what the object links to.
 */
export async function readingOf(
  inspection: Inspection,
  reader: Reader,
  readings: readonly ReadingAs<unknown>[],
): Promise<Reading | undefined> {
  if (inspection.kind !== "object") return undefined;
  for (const as of readings) {
    const implementation = as.implementations.implementationOf(inspection.schema.link as Link<Schema>);
    if (implementation === undefined) continue;
    try {
      const object = decodeObject(inspection.bytes, implementation.schema);
      return { kind: "read", as, value: await implementation.read(object, reader) };
    } catch (error) {
      return { kind: "unread", as, error };
    }
  }
  return undefined;
}
