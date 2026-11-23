import type { InspectedObject } from "@estoc/inspector";
import { decodeObject, type Implementations, type Link, type Reader, type Schema } from "@estoc/object";
import type { JSX } from "@solidjs/web";

export interface ReadingAs<T> {
  readonly name: string;
  readonly implementations: Implementations<T>;
  viewOf(value: T): JSX.Element;
}

export type Reading<T = unknown> =
  | { readonly kind: "read"; readonly as: ReadingAs<T>; readonly value: T }
  | { readonly kind: "unread"; readonly as: ReadingAs<T>; readonly error: unknown };

/**
 * A schema is matched by its link and not by its title. The page holds the schema, so the object is
 * read whether or not the reader gives the blob of its schema.
 */
export async function readingOf(
  object: InspectedObject,
  reader: Reader,
  readings: readonly ReadingAs<unknown>[],
): Promise<Reading | undefined> {
  for (const as of readings) {
    const implementation = as.implementations.implementationOf(object.schema.link as Link<Schema>);
    if (implementation === undefined) continue;
    try {
      return {
        kind: "read",
        as,
        value: await implementation.read(decodeObject(object.bytes, implementation.schema), reader),
      };
    } catch (error) {
      return { kind: "unread", as, error };
    }
  }
  return undefined;
}
