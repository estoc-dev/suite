import { type Bytes, type Link, linkOf } from "@estoc/object";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * What the objects of a schema read as, whichever of several schemas they
 * are written to: a blob that each such schema names by link in
 * `x-implements`. The link goes along with the schema wherever its links
 * are followed, so whoever holds the schema can get the interface too.
 *
 * An interface here is its name in UTF-8. A program still reads the
 * concrete schemas it knows and turns each into the interface's shape; the
 * mark lets the schemas say which shape that is.
 */
export interface Interface {
  readonly bytes: Bytes<Interface>;
  readonly link: Link<Interface>;
}

function named(name: string): Interface {
  const bytes: Bytes<Interface> = utf8ToBytes(name);
  return { bytes, link: linkOf(bytes) };
}

export const keyInterface: Interface = named("Key");

/** What the objects of each identity schema read as: an identity with its root. */
export const identityInterface: Interface = named("Identity");
