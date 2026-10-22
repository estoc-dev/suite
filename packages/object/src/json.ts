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

function checkLinks(value: Json): void {
  if (isJsonObject(value)) {
    if (Object.hasOwn(value, "$link") && !isJsonLink(value)) {
      throw new Error('an object with a $link member is a link, {"$link": "sha256:<hex>"}, and holds nothing else');
    }
    for (const member of Object.values(value)) checkLinks(member);
  } else if (value !== null && typeof value === "object") {
    for (const item of value) checkLinks(item);
  }
}

// A decoder left to its defaults strips a leading byte order mark, and the
// bytes would then pass as canonical; kept, it fails to parse as JSON.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * JSON values, each written as its JCS (RFC 8785) encoding in UTF-8. Bytes
 * that are anything else are refused, not normalized: invalid UTF-8,
 * whitespace, keys out of order or repeated, and numbers or escapes not
 * written the shortest way. A link is written `{"$link": <link>}`, and any
 * other object with a `$link` member is refused. An object is the JSON
 * object `{"data": <data>, "schema": {"$link": <link>}}`, with no other
 * member.
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
  object: (data, schema) => ({ data, schema: { $link: schema } }),
  fields(value) {
    if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
      throw new Error("an object has the fields data and schema");
    }
    const { data, schema } = value as { readonly data: Json; readonly schema: Json };
    if (!isJsonLink(schema)) throw new Error("an object names its schema by link");
    return { data, schema: schema.$link };
  },
  links: linksIn,
};

/**
 * Every string in the value that is a link as a whole, member names
 * included: a link is a string, and JSON gives no other sign of one.
 */
function* linksIn(value: Json): Generator<Link<never>> {
  if (typeof value === "string") {
    if (isLink(value)) yield value;
  } else if (isJsonObject(value)) {
    for (const [name, member] of Object.entries(value)) {
      if (isLink(name)) yield name;
      yield* linksIn(member);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of value) yield* linksIn(item);
  }
}
