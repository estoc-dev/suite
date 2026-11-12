import { type Bytes, est, type Link, linkOf, schemaOf } from "@estoc/object";
import { encode, Tokenizer, Type } from "cborg";
import { Bundle } from "./bundle.ts";
import { joined } from "./bytes.ts";

function checkRoot(bytes: Uint8Array): void {
  try {
    schemaOf(bytes, est);
  } catch (cause) {
    throw new Error("the root of a bundle in one file is an object of est", { cause });
  }
}

// Whether the value is an object is the encoding's to say, once its bytes are
// set apart from the blobs after it.
function passValue(tokens: Tokenizer): void {
  const token = tokens.next();
  if (token.type.terminal) return;
  const items = Type.equals(token.type, Type.tag)
    ? 1
    : Type.equals(token.type, Type.map)
      ? token.value * 2
      : token.value;
  for (let item = 0; item < items; item++) passValue(tokens);
}

/**
 * The bundle of `root` and `blobs` as one file: the bytes of the root, then each blob as a CBOR
 * byte string.
 *
 * - With no blobs the file is the bytes of the root, and the hash of the file is its link.
 * - The blobs are written in the order given. A blob given twice is written once, and the root
 *   given among the blobs is left out.
 *
 * @throws when `root` is not an object of est, since no reader would take the file.
 */
export function encodeBundle(root: { readonly bytes: Bytes<unknown> }, blobs: Iterable<Bytes<unknown>>): Uint8Array {
  checkRoot(root.bytes);
  const links = new Set<Link<unknown>>([linkOf(root.bytes)]);
  const parts: Uint8Array[] = [root.bytes];
  for (const blob of blobs) {
    const link = linkOf(blob);
    if (links.has(link)) continue;
    links.add(link);
    parts.push(encode(blob));
  }
  return joined(parts);
}

/**
 * Reads a bundle from one file: an object of est, the root, then each blob it carries as a CBOR
 * byte string.
 *
 * - A blob is any bytes and is not read, so an object carried in the file is a byte string as an
 *   image is.
 * - Nothing in the file is compressed, so the blobs come to less than its length, and reading has
 *   no other limit.
 *
 * @throws when the file does not start with an object of est.
 * @throws when what follows the root is not byte strings, each of a definite length under the
 *   shortest head, the last ending where the file does.
 * @throws when the file holds a blob twice, the root included.
 */
export function decodeBundle(file: Uint8Array): Bundle {
  // The root and each blob are copied out of the file before they are hashed,
  // so that what was checked is what is kept, whatever happens to the given
  // array afterwards. A file read in Node is a Buffer, whose `slice` shares
  // memory instead of copying, so the file is read through a plain view.
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const tokens = new Tokenizer(bytes, { strict: true, allowIndefinite: false });
  try {
    passValue(tokens);
  } catch (cause) {
    throw new Error("the root of a bundle in one file is an object of est", { cause });
  }
  const root = bytes.slice(0, tokens.pos());
  checkRoot(root);
  const link = linkOf(root);
  const blobs = new Map<Link<unknown>, Uint8Array>();
  while (!tokens.done()) {
    const token = tokens.next();
    if (!Type.equals(token.type, Type.bytes)) throw new Error("a blob after the root is a byte string");
    const blob: Uint8Array = token.value;
    const blobLink = linkOf(blob);
    if (blobLink === link || blobs.has(blobLink)) throw new Error(`the file holds the blob ${blobLink} twice`);
    blobs.set(blobLink, blob);
  }
  return new Bundle(root, link, blobs);
}
