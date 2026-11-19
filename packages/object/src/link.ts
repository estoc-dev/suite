import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

declare const target: unique symbol;

export type Link<T> = `sha256:${string}` & { readonly [target]?: T };

/**
 * `T` is what the bytes decode to, so that the bytes of one kind of blob are not handed to the
 * reader of another. It is a label, not a check: bytes read from a file or the network pass as any
 * `Bytes<T>`.
 */
export type Bytes<T> = Uint8Array & { readonly [target]?: T };

const linkText = /^sha256:[0-9a-f]{64}$/;

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

export function digestOf(link: Link<unknown>): Uint8Array {
  return hexToBytes(link.slice("sha256:".length));
}
