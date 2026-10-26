export const ZIP = "application/zip";

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
