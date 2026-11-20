import type { Inspection } from "@estoc/inspector";
import { decodeObject, type Implementations, type Link, type Reader, type Schema } from "@estoc/object";
import type { Child } from "./dom.ts";

export interface ReadingAs<T> {
  readonly name: string;
  /**
   * Asked once for each file opened. Implementations that keep what they read are made anew, so
   * that a file is read from itself alone and not from a file opened before.
   */
  implementations(): Implementations<T>;
  viewOf(value: T): Child;
}

export interface FileReading<T = unknown> {
  readonly as: ReadingAs<T>;
  readonly implementations: Implementations<T>;
}

export const fileReadingsOf = (readings: readonly ReadingAs<unknown>[]): readonly FileReading[] =>
  readings.map((as) => ({ as, implementations: as.implementations() }));

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
  readings: readonly FileReading[],
): Promise<Reading | undefined> {
  if (inspection.kind !== "object") return undefined;
  for (const { as, implementations } of readings) {
    const implementation = implementations.implementationOf(inspection.schema.link as Link<Schema>);
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
