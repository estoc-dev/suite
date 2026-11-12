import { type Bytes, type Link, linkOf, objectFormat, schemaOf } from "@estoc/object";
import { encode, Tokenizer, Type } from "cborg";

/**
 * An object, the root, and blobs carried with it, held by link. Holding one means that the file it
 * was read from was checked:
 *
 * - The root is an object.
 * - Every blob is held by the link of its bytes.
 *
 * Nothing else about the blobs is read, signatures included.
 */
export class Bundle {
  /**
   * An object of any schema, a signature included, so neither its bytes nor its link name a type,
   * and they can be read as either.
   */
  readonly root: Uint8Array;
  readonly link: Link<never>;
  readonly #blobs: Map<string, Uint8Array>;

  /**
   * Takes what `decodeBundle` has checked and keeps as its own: the root, which is an object and
   * has `link`, and each blob by its link, the root among them or not.
   */
  constructor(root: Uint8Array, link: Link<never>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>) {
    this.root = root;
    this.link = link;
    this.#blobs = new Map([[link, root], ...blobs]);
  }

  /** The root, or a blob carried with it, by its link. */
  get<T>(link: Link<T>): Bytes<T> | undefined;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Bytes<unknown> | undefined;
  get(link: Link<unknown>): Bytes<unknown> | undefined {
    return this.#blobs.get(link);
  }

  /** The root and the blobs carried with it, each once, as a store takes them in. */
  blobs(): Iterable<Bytes<unknown>> {
    return this.#blobs.values();
  }
}

function checkRoot(bytes: Uint8Array): void {
  try {
    schemaOf(bytes, objectFormat);
  } catch (cause) {
    throw new Error("the root of a bundle is an object", { cause });
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

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * The file of the bundle of `root` and `blobs`: the bytes of the root, then each blob as a CBOR
 * byte string.
 *
 * - With no blobs the file is the bytes of the root, and the hash of the file is its link.
 * - The blobs are written in the order given. A blob given twice is written once, and the root
 *   given among the blobs is left out.
 *
 * @throws when `root` is not an object, since no reader would take the file.
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
 * Reads a bundle from its file: an object, the root, then each blob it carries as a CBOR
 * byte string.
 *
 * - A blob is any bytes and is not read, so an object carried in the file is a byte string as an
 *   image is.
 * - Nothing in the file is compressed, so the blobs come to less than its length, and reading has
 *   no other limit.
 *
 * @throws when the file does not start with an object.
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
    throw new Error("the root of a bundle is an object", { cause });
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
