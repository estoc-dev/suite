import { type Bytes, type Link, linkOf, schemaOf } from "@estoc/object";
import { encode, Tokenizer, Type } from "cborg";

/**
 * Reading one checks that the root is an object and that each blob is held by the link of its
 * bytes, and nothing more, signatures included.
 */
export class Bundle {
  /** Any object, a signature included, so neither its bytes nor its link name a type. */
  readonly root: Uint8Array;
  readonly link: Link<never>;
  readonly #blobs: Map<string, Uint8Array>;

  constructor(root: Uint8Array, link: Link<never>, blobs: ReadonlyMap<Link<unknown>, Uint8Array>) {
    this.root = root;
    this.link = link;
    this.#blobs = new Map([[link, root], ...blobs]);
  }

  get<T>(link: Link<T>): Bytes<T> | undefined;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Bytes<unknown> | undefined;
  get(link: Link<unknown>): Bytes<unknown> | undefined {
    return this.#blobs.get(link);
  }

  blobs(): Iterable<Bytes<unknown>> {
    return this.#blobs.values();
  }
}

function checkRoot(bytes: Uint8Array): void {
  try {
    schemaOf(bytes);
  } catch (cause) {
    throw new Error("the root of a bundle is an object", { cause });
  }
}

// Whether the value is an object is the object format's to say, once its bytes
// are set apart from the blobs after it.
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

function joined(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The file takes the extension `.eof`. */
export function encodeBundle(root: Link<unknown>, blobs: Iterable<Bytes<unknown>>): Uint8Array<ArrayBuffer> {
  const givenLinks = new Set<Link<unknown>>();
  const otherBlobs: Uint8Array[] = [];
  let rootBytes: Uint8Array | undefined;
  for (const blob of blobs) {
    const link = linkOf(blob);
    if (givenLinks.has(link)) continue;
    givenLinks.add(link);
    // Not `blob.slice()`, which for a `Buffer` gives a view of the same memory.
    if (link === root) rootBytes = new Uint8Array(blob);
    else otherBlobs.push(encode(blob));
  }
  if (rootBytes === undefined) throw new Error(`the blobs of a bundle hold its root, and ${root} is not among them`);
  checkRoot(rootBytes);
  return joined([rootBytes, ...otherBlobs]);
}

/**
 * Nothing in the file is compressed, so its length bounds what reading it takes, and there is no
 * other limit.
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
