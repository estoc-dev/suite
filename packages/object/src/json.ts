import { utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import type { Encoding } from "./encoding.ts";
import { isLink, type Link } from "./link.ts";

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A link in JSON: an object whose one member is `$link`, holding the link.
 * JSON has no type for a link, so this marks one, and a string is a string
 * whatever it holds.
 */
export type JsonLink<T> = { readonly $link: Link<T> };

function isJsonLink(value: Json): value is JsonLink<never> {
  if (!isJsonObject(value)) return false;
  const names = Object.keys(value);
  return names.length === 1 && names[0] === "$link" && isLink(value.$link);
}

function* linksIn(value: Json): Generator<Link<never>> {
  if (isJsonObject(value)) {
    if (Object.hasOwn(value, "$link")) {
      if (!isJsonLink(value)) {
        throw new Error('an object with a $link member is a link, {"$link": "sha256:<hex>"}, and holds nothing else');
      }
      yield value.$link;
    } else {
      for (const member of Object.values(value)) yield* linksIn(member);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of value) yield* linksIn(item);
  }
}

function checkLinks(value: Json): void {
  for (const _ of linksIn(value));
}

// A decoder left to its defaults strips a leading byte order mark, and the
// bytes would then pass as canonical; kept, it fails to parse as JSON.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * JSON values, each written as its JCS (RFC 8785) encoding in UTF-8. Bytes
 * that are anything else are refused, not normalized: invalid UTF-8,
 * whitespace, keys out of order or repeated, and numbers or escapes not
 * written the shortest way. A link is written `{"$link": <link>}`, and any
 * other object with a `$link` member is refused. An object is the JSON object
 * of the fields of its data and `"$describedBy": {"$link": <link>}`, the
 * link of its schema. Only there does `$describedBy` name a schema: deeper in
 * the data it is a field like any other.
 */
export const json: Encoding<Json> = {
  encode(value) {
    checkLinks(value);
    const text = canonicalize(value);
    if (text === undefined) throw new TypeError("not a JSON value");
    return utf8ToBytes(text);
  },
  decode(bytes) {
    const text = utf8.decode(bytes);
    const value = JSON.parse(text) as Json;
    if (canonicalize(value) !== text) throw new Error("not in the canonical JSON form of RFC 8785");
    checkLinks(value);
    return value;
  },
  object(data, schema) {
    if (Object.hasOwn(data, "$describedBy"))
      throw new Error("the data of an object holds no $describedBy, which names the object's schema");
    return { ...data, $describedBy: { $link: schema } };
  },
  fields(value) {
    if (!isJsonObject(value)) throw new Error("an object is a JSON object");
    const { $describedBy, ...data } = value;
    if ($describedBy === undefined || !isJsonLink($describedBy))
      throw new Error("an object names its schema by link in $describedBy");
    return { data, schema: $describedBy.$link };
  },
  links: linksIn,
};
