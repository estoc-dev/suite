import { readBundle, unzipBundle, writeBundle, type Bundle } from "@estoc/bundle";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** Reads the bundle at `path`, a folder or a zip of one. */
export async function readBundleAt(path: string): Promise<Bundle> {
  if (!(await stat(path)).isDirectory()) return readBundle(await unzipBundle(await readFile(path)));
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files.set(relative(path, file).split(sep).join("/"), await readFile(file));
  }
  return readBundle(files);
}

/**
 * Writes `bundle` into the folder at `path`, adding to the files there. A
 * file of the same name holds the same bytes, as long as the folder is one
 * bundle's: each blob is named by its link, and the root names the bundle.
 */
export async function writeBundleTo(path: string, bundle: Bundle): Promise<void> {
  for (const [name, bytes] of writeBundle({ bytes: bundle.root }, bundle.blobs())) {
    const file = join(path, name);
    await mkdir(dirname(file), { recursive: true });
    // Renamed into place, so that a file is there whole or not at all.
    const part = `${file}.${randomUUID()}.part`;
    await writeFile(part, bytes);
    await rename(part, file);
  }
}
