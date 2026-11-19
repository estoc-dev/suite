/** A bundle has no media type of its own, so it goes as bytes. */
export const BUNDLE_TYPE = "application/octet-stream";

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

export const PICKUP = { count: 100, bytes: 1024 * 1024 } as const;
