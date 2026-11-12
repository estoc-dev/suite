import { type Bytes, json, type Link, linkOf, schemaOf } from "@estoc/object";

export const ROOT = "index.json";
export const BLOB = /^blobs\/sha256\/([0-9a-f]{64})$/;

/**
 * An object, the root, and blobs carried with it, held by link. Holding one means that what it was
 * read from was checked:
 *
 * - The root is an object: of JSON in a folder or a zip, of est in one file.
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
   * Takes what a reader of this package has checked and keeps as its own: the root, which is an
   * object and has `link`, and each blob by its link, the root among them or not.
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
    schemaOf(bytes, json);
  } catch (cause) {
    throw new Error(`${ROOT} is not an object in canonical JSON`, { cause });
  }
}

/**
 * Reads a bundle from its files by path: a folder read into memory, or a zip unzipped. The root is
 * `index.json`, and a blob is a file under `blobs/sha256/`.
 *
 * @throws when `index.json` is missing or is not an object in canonical JSON.
 * @throws when a blob does not have the link its name says.
 */
export function readBundle(files: ReadonlyMap<string, Uint8Array>): Bundle {
  const index = files.get(ROOT);
  if (index === undefined) throw new Error(`a bundle has an ${ROOT}`);
  // Each blob is copied before it is hashed, so that what was checked is
  // what is kept, whatever happens to the given arrays afterwards. A file
  // read in Node is a Buffer, whose `slice` shares memory instead of copying.
  const root = new Uint8Array(index);
  checkRoot(root);
  const blobs = new Map<Link<unknown>, Uint8Array>();
  for (const [path, bytes] of files) {
    // Any other path is not a blob: a directory entry, a file an archiver
    // adds, or a name that no link turns into.
    const hex = BLOB.exec(path)?.[1];
    if (hex === undefined) continue;
    const blob = new Uint8Array(bytes);
    const link = linkOf(blob);
    if (link !== `sha256:${hex}`) throw new Error(`${path} holds the blob ${link}`);
    blobs.set(link, blob);
  }
  return new Bundle(root, linkOf(root), blobs);
}

/**
 * The files of a bundle with `root` as its `index.json`, carrying `blobs`. `root` is an object of
 * whatever type the caller holds it as: only its bytes are written.
 *
 * @throws when `root` is not an object in canonical JSON, since no reader would take the bundle.
 */
export function writeBundle(
  root: { readonly bytes: Bytes<unknown> },
  blobs: Iterable<Bytes<unknown>>,
): Map<string, Uint8Array> {
  checkRoot(root.bytes);
  const files = new Map<string, Uint8Array>([[ROOT, root.bytes]]);
  for (const blob of blobs) files.set(`blobs/${linkOf(blob).replace(":", "/")}`, blob);
  return files;
}
