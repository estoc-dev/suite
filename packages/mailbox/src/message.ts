import { decodeJson, encodeJson, type Bytes, type Json, type Signature } from "@estoc/object";
import { base64urlnopad } from "@scure/base";

/**
 * What a mailbox carries: an entry blob and the blobs it leads to, in the
 * shape a reader such as `readStanding` takes them. The sender is written
 * nowhere in it.
 */
export interface Message {
  readonly entry: Bytes<Signature>;
  readonly blobs: readonly Bytes<unknown>[];
}

/**
 * Writes a message as the JCS encoding of
 * `{"blobs": [<base64url>, …], "entry": <base64url>}`, unpadded. Each blob
 * is carried as its bytes, in the order given.
 */
export function encodeMessage({ entry, blobs }: Message): Uint8Array {
  return encodeJson({ blobs: blobs.map((blob) => base64urlnopad.encode(blob)), entry: base64urlnopad.encode(entry) });
}

/** Reads a message, refusing any encoding but the one `encodeMessage` writes. */
export function decodeMessage(bytes: Uint8Array): Message {
  const { value } = decodeJson(bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join() !== "blobs,entry") {
    throw new Error("a message has the fields blobs and entry");
  }
  const { blobs, entry } = value as { blobs: Json; entry: Json };
  if (typeof entry !== "string" || !Array.isArray(blobs) || !blobs.every((blob) => typeof blob === "string")) {
    throw new Error("a message holds its entry and its blobs as strings");
  }
  return { entry: base64urlnopad.decode(entry), blobs: blobs.map((blob: string) => base64urlnopad.decode(blob)) };
}
