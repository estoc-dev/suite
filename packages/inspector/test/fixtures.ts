import { type Link, linkOf, type Reader } from "@estoc/object";

export function readerOf(...blobs: readonly Uint8Array[]): Reader {
  return new Map<Link<unknown>, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
}
