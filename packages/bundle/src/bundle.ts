import { linkOf, schemaOf, type Bytes, type Link } from "@estoc/object";

export const ROOT = "index.json";
export const BLOB = /^blobs\/sha256\/([0-9a-f]{64})$/;

/**
 * An object, the root, and blobs carried with it, held by link. Holding one
 * means its files were checked: `index.json` is an object in canonical JSON,
 * and every blob under `blobs/sha256/` has the link its name says. Nothing
 * else about the blobs is read, signatures included.
 */
export class Bundle {
  /**
   * `index.json`: an object of any schema, a signature included, so neither its
   * bytes nor its link carry a label, and they read as either.
   */
  readonly root: Uint8Array;
  readonly link: Link<never>;
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(files: ReadonlyMap<string, Uint8Array>) {
    const index = files.get(ROOT);
    if (index === undefined) throw new Error(`a bundle has an ${ROOT}`);
    // Each blob is copied before it is hashed, so that what was checked is
    // what is kept, whatever happens to the given arrays afterwards. A file
    // read in Node is a Buffer, whose `slice` shares memory instead of copying.
    this.root = new Uint8Array(index);
    try {
      schemaOf(this.root);
    } catch (cause) {
      throw new Error(`${ROOT} is not an object in canonical JSON`, { cause });
    }
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
 * Reads a bundle from its files by path: a folder read into memory, or a zip
 * unpacked. Refuses it when `index.json` is missing or is not an object, or
 * when a blob does not have the link its name says.
 */
export function readBundle(files: ReadonlyMap<string, Uint8Array>): Bundle {
  return new Bundle(files);
}

/**
 * The files of a bundle with `root` as its `index.json`, carrying `blobs`.
 * `root` is an object in whatever type a semantics read it into, and its
 * bytes are what is written.
 */
export function writeBundle(root: { readonly bytes: Bytes<unknown> }, blobs: Iterable<Bytes<unknown>>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([[ROOT, root.bytes]]);
  for (const blob of blobs) files.set(`blobs/${linkOf(blob).replace(":", "/")}`, blob);
  return files;
}
