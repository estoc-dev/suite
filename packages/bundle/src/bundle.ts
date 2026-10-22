import { defaultEncoding, linkOf, schemaOf, type Bytes, type Encoding, type Json, type Link } from "@estoc/object";

/** The root: `index.` and the name of the encoding it is in. */
export const ROOT = /^index\.[a-z0-9]+$/;
export const BLOB = /^blobs\/sha256\/([0-9a-f]{64})$/;

/**
 * An object, the root, and blobs carried with it, held by link. Holding one
 * means its files were checked: the root is an object in the encoding its
 * file name gives, and every blob under `blobs/sha256/` has the link its name
 * says. Nothing else about the blobs is read, signatures included.
 */
export class Bundle<D = Json> {
  /**
   * An object of any schema, a signature included, so neither its bytes nor
   * its link carry a label, and they read as either.
   */
  readonly root: Uint8Array;
  readonly link: Link<never>;
  /** The encoding of the root, which its file name gives. */
  readonly encoding: Encoding<D>;
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(files: ReadonlyMap<string, Uint8Array>, encodings: readonly Encoding<D>[]) {
    const [path, ...others] = [...files.keys()].filter((path) => ROOT.test(path));
    if (path === undefined) throw new Error("a bundle has a root, index.<encoding>");
    if (others.length > 0) throw new Error(`a bundle has one root, not ${[path, ...others].join(" and ")}`);
    const encoding = encodings.find(({ name }) => path === `index.${name}`);
    if (encoding === undefined) throw new Error(`the root, ${path}, is in an encoding not read here`);
    // Each blob is copied before it is hashed, so that what was checked is
    // what is kept, whatever happens to the given arrays afterwards. A file
    // read in Node is a Buffer, whose `slice` shares memory instead of copying.
    this.root = new Uint8Array(files.get(path)!);
    checkRoot(this.root, encoding);
    this.encoding = encoding;
    this.link = linkOf(this.root);
    this.#blobs.set(this.link, this.root);
    for (const [path, bytes] of files) {
      // Any other path is not a blob: a directory entry, a file an archiver
      // adds, or a name that no link turns into.
      const hex = BLOB.exec(path)?.[1];
      if (hex === undefined) continue;
      const blob = new Uint8Array(bytes);
      const link = linkOf(blob);
      if (link !== `sha256:${hex}`) throw new Error(`${path} holds the blob ${link}`);
      this.#blobs.set(link, blob);
    }
  }

  /** The root, or a blob under `blobs/sha256/`, by its link. */
  get<T>(link: Link<T>): Bytes<T> | undefined;
  // For links of several kinds at once, as in an array of the links of objects
  // and signatures: TypeScript infers `T` from one kind and refuses the others.
  get(link: Link<unknown>): Bytes<unknown> | undefined;
  get(link: Link<unknown>): Bytes<unknown> | undefined {
    return this.#blobs.get(link);
  }
}

/**
 * An encoding for each data type in `Ds`. An encoding both reads and writes
 * its data type, so encodings of different data types have no common type,
 * and a list of them is typed member by member.
 */
export type Encodings<Ds extends readonly unknown[]> = { readonly [K in keyof Ds]: Encoding<Ds[K]> };

/** A bundle whose root is in the encoding of one of the data types in `Ds`. */
export type BundleIn<Ds extends readonly unknown[]> = { [K in keyof Ds]: Bundle<Ds[K]> }[number];

/**
 * Reads a bundle from its files by path: a folder read into memory, or a zip
 * unpacked. Its root is read in one of `encodings`, which may be of different
 * data types, `defaultEncoding` unless given. Refuses it when it has no root
 * or more than one, when the root is in none of those encodings or is not an
 * object in its encoding, or when a blob does not have the link its name
 * says.
 */
export function readBundle(files: ReadonlyMap<string, Uint8Array>): Bundle;
export function readBundle<Ds extends readonly unknown[]>(files: ReadonlyMap<string, Uint8Array>, encodings: Encodings<Ds>): BundleIn<Ds>;
export function readBundle<D>(files: ReadonlyMap<string, Uint8Array>, encodings?: readonly Encoding<D>[]): Bundle<D> | Bundle {
  return encodings === undefined ? new Bundle(files, [defaultEncoding]) : new Bundle(files, encodings);
}

/**
 * The files of a bundle with `root` as its root, carrying `blobs`. `root` is
 * an object in `encoding`, `defaultEncoding` unless given, in whatever type a
 * semantics read it into, and its bytes are what is written. Refuses a root
 * that is not an object in that encoding, which no reader would take.
 */
export function writeBundle<D>(
  root: { readonly bytes: Bytes<unknown> },
  blobs: Iterable<Bytes<unknown>>,
  encoding?: Encoding<D>,
): Map<string, Uint8Array> {
  return encoding === undefined ? filesOf(root, blobs, defaultEncoding) : filesOf(root, blobs, encoding);
}

function filesOf<D>(
  root: { readonly bytes: Bytes<unknown> },
  blobs: Iterable<Bytes<unknown>>,
  encoding: Encoding<D>,
): Map<string, Uint8Array> {
  const path = `index.${encoding.name}`;
  if (!ROOT.test(path)) throw new Error(`the name of an encoding is lowercase letters and digits, not ${encoding.name}`);
  checkRoot(root.bytes, encoding);
  const files = new Map<string, Uint8Array>([[path, root.bytes]]);
  for (const blob of blobs) files.set(`blobs/${linkOf(blob).replace(":", "/")}`, blob);
  return files;
}

function checkRoot<D>(bytes: Uint8Array, encoding: Encoding<D>): void {
  try {
    schemaOf(bytes, encoding);
  } catch (cause) {
    throw new Error(`the root is not an object in ${encoding.name}`, { cause });
  }
}
