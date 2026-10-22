import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

declare const target: unique symbol;

/**
 * A blob named by the SHA-256 of its bytes: `sha256:` and 64 lowercase hex
 * digits. `T` is what the blob decodes to.
 */
export type Link<T> = `sha256:${string}` & { readonly [target]?: T };

/**
 * The bytes of a blob. `T` is what they decode to, as it is for a link, so
 * that the bytes of one kind of blob are not handed to the reader of another.
 * The type is a label, not a check: bytes read from a file or the network
 * pass as any `Bytes<T>`.
 */
export type Bytes<T> = Uint8Array & { readonly [target]?: T };

/** What a link looks like, as a pattern that a schema can use as well. */
export const LINK_PATTERN = "^sha256:[0-9a-f]{64}$";
const linkText = new RegExp(LINK_PATTERN);

export function isLink(value: unknown): value is Link<never> {
  return typeof value === "string" && linkText.test(value);
}

export function linkOf<T = never>(bytes: Bytes<T>): Link<T>;
// For bytes of several kinds at once, as in an array of objects and
// signatures: TypeScript infers `T` from one kind and refuses the others.
export function linkOf(bytes: Bytes<unknown>): Link<unknown>;
export function linkOf(bytes: Uint8Array): Link<unknown> {
  return `sha256:${bytesToHex(sha256(bytes))}` as const;
}

/** The SHA-256 digest that a link names. */
export function digestOf(link: Link<unknown>): Uint8Array {
  return hexToBytes(link.slice("sha256:".length));
}
