import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

declare const target: unique symbol;

/**
 * A blob named by the SHA-256 of its bytes: `sha256:` and 64 lowercase hex
 * digits. `T` is what the blob decodes to.
 */
export type Link<T> = `sha256:${string}` & { readonly [target]?: T };

/** What a link looks like, as a pattern that a JSON Schema can use as well. */
export const LINK_PATTERN = "^sha256:[0-9a-f]{64}$";
const linkText = new RegExp(LINK_PATTERN);

export function isLink(value: unknown): value is Link<never> {
  return typeof value === "string" && linkText.test(value);
}

export function linkOf(bytes: Uint8Array): Link<never> {
  return `sha256:${bytesToHex(sha256(bytes))}` as const;
}

/** The SHA-256 digest that a link names. */
export function digestOf(link: Link<unknown>): Uint8Array {
  return hexToBytes(link.slice("sha256:".length));
}

export interface Decoded {
  readonly value: Json;
  readonly bytes: Uint8Array;
  readonly link: Link<never>;
}

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeJson(value: Json): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("not a JSON value");
  return utf8ToBytes(text);
}

// A decoder left to its defaults strips a leading byte order mark, and the
// bytes would then pass as canonical; kept, it fails to parse as JSON.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads bytes that must be the JCS (RFC 8785) encoding of the value they
 * hold, so that a value has one encoding and therefore one link. Anything
 * else is refused, not normalized: invalid UTF-8, whitespace, keys out of
 * order or repeated, and numbers or escapes not written the shortest way.
 */
export function decodeJson(bytes: Uint8Array): Decoded {
  const text = utf8.decode(bytes);
  const value = JSON.parse(text) as Json;
  if (canonicalize(value) !== text) throw new Error("not in the canonical JSON form of RFC 8785");
  const owned = utf8ToBytes(text);
  return { value, bytes: owned, link: linkOf(owned) };
}
