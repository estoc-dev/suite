import type { Inspection } from "@estoc/inspector";
import { decodeObject, type Implementations, type Link, type Reader, type Schema } from "@estoc/object";
import type { Child } from "./dom.ts";

export interface ReadingAs<T> {
  readonly name: string;
  /**
   * Asked at each reading. Implementations that keep what they read are made anew, so that a
   * reading reads from its reader alone and not from a file opened before.
   */
  implementations(): Implementations<T>;
  viewOf(value: T): Child;
}

export type Reading<T = unknown> =
  | { readonly kind: "read"; readonly as: ReadingAs<T>; readonly value: T }
  | { readonly kind: "unread"; readonly as: ReadingAs<T>; readonly error: unknown };

/**
 * A schema is matched by its link and not by its title. The page holds the schema, so the object is
 * read whether or not the reader gives the blob of its schema.
 */
export async function readingOf(
  inspection: Inspection,
  reader: Reader,
  readings: readonly ReadingAs<unknown>[],
): Promise<Reading | undefined> {
  if (inspection.kind !== "object") return undefined;
  for (const as of readings) {
    const implementation = as.implementations().implementationOf(inspection.schema.link as Link<Schema>);
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
