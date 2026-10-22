import { utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import type { Encoding } from "./encoding.ts";
import { isLink } from "./link.ts";

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A decoder left to its defaults strips a leading byte order mark, and the
// bytes would then pass as canonical; kept, it fails to parse as JSON.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * JSON values, each written as its JCS (RFC 8785) encoding in UTF-8. Bytes
 * that are anything else are refused, not normalized: invalid UTF-8,
 * whitespace, keys out of order or repeated, and numbers or escapes not
 * written the shortest way. An object is the JSON object `{"data": <data>,
 * "schema": <link>}`, with no other member.
 */
export const json: Encoding<Json> = {
  name: "json",
  encode(value) {
    const text = canonicalize(value);
    if (text === undefined) throw new TypeError("not a JSON value");
    return utf8ToBytes(text);
  },
  decode(bytes) {
    const text = utf8.decode(bytes);
    const value = JSON.parse(text) as Json;
    if (canonicalize(value) !== text) throw new Error("not in the canonical JSON form of RFC 8785");
    return value;
  },
  object: (data, schema) => ({ data, schema }),
  fields(value) {
    if (!isJsonObject(value) || Object.keys(value).sort().join() !== "data,schema") {
      throw new Error("an object has the fields data and schema");
    }
    const { data, schema } = value as { readonly data: Json; readonly schema: Json };
    if (!isLink(schema)) throw new Error("an object names its schema by link");
    return { data, schema };
  },
};
