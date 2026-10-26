import { readBundle, unzipBundle, writeBundle, zipBundle, type Bundle } from "@estoc/bundle";
import type { Bytes } from "@estoc/object";

export const ZIP = "application/zip";

/** The zip of the bundle of `root` and `blobs`, without compression, which is how every bundle travels to and from a service. */
export function zipped(root: { readonly bytes: Bytes<unknown> }, blobs: Iterable<Bytes<unknown>>): Promise<Uint8Array> {
  return zipBundle(writeBundle(root, blobs), { compress: false });
}

/**
 * Reads a bundle from its zip, and refuses one whose files come to more
 * bytes than the zip. A zip without compression is larger than its files,
 * so only a compressed one is refused for it, which could otherwise unzip
 * to far more than arrived.
 */
export async function unzipped(zip: Uint8Array): Promise<Bundle> {
  return readBundle(await unzipBundle(zip, { bytes: zip.length }));
}

/** The bytes of a body, or `undefined` when it holds more than `limit`, of which no more is read. */
export async function readBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    length += read.value.length;
    if (length > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
