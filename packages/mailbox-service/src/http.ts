export const ZIP = "application/zip";

/** The bytes of a body, or `undefined` when it holds more than `limit`, in which case no chunk is read after the one that goes past `limit`. */
export async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | undefined> {
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

/**
 * A pickup is answered with at most `count` ciphertexts, and at most
 * `bytes` of them, but with one at least while any waits, however large.
 */
export const PICKUP = { count: 100, bytes: 1024 * 1024 } as const;
