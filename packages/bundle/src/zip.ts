import { Unzip, UnzipInflate, unzipSync, zipSync } from "fflate";
import { BLOB, ROOT } from "./bundle.ts";

const LIMITS = { bytes: 64 * 2 ** 20, entries: 10_000 };

/**
 * Zips the files of a bundle as they are, `index.json` at the top of the zip.
 * Every entry is dated 1980-01-01, the earliest date a zip can hold, so that a
 * zip does not tell when or in which time zone it was made. The date is in
 * local time, which is what a zip records.
 */
export function zipBundle(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files), { mtime: new Date(1980, 0, 1) });
}

/**
 * Unzips the files of a bundle into memory: `index.json` and the blobs under
 * `blobs/sha256/`. Other entries are not unzipped, so a path such as `../` is
 * not written anywhere. Refuses the zip when its entries are not the ones its
 * directory lists, when it holds a path twice, or when it goes over `limits`:
 * 64 MiB unzipped and 10,000 entries unless given.
 */
export function unzipBundle(
  zip: Uint8Array,
  limits: { readonly bytes?: number; readonly entries?: number } = {},
): Map<string, Uint8Array> {
  const { bytes = LIMITS.bytes, entries = LIMITS.entries } = limits;
  // The directory at the end of a zip lists its entries, and a zip cut short
  // has none. The entries are listed from it first, and unzipping them one
  // after another has to come to exactly those.
  const listed = new Set<string>();
  unzipSync(zip, {
    filter: ({ name }) => {
      if (listed.has(name)) throw new Error(`the zip holds ${name} twice`);
      listed.add(name);
      if (listed.size > entries) throw new Error(`the zip has more than ${entries} entries`);
      return false;
    },
  });
  const files = new Map<string, Uint8Array>();
  let unzipped = 0;
  const unzip = new Unzip((file) => {
    if (!listed.delete(file.name)) throw new Error(`the zip holds ${file.name} more often than its directory lists it`);
    if (file.name !== ROOT && !BLOB.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      // Counted as they come out, since the sizes a zip gives can be false.
      unzipped += chunk.length;
      if (unzipped > bytes) throw new Error(`the zip unzips to more than ${bytes} bytes`);
      chunks.push(chunk);
      if (final) files.set(file.name, joined(chunks));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(zip, true);
  const [missing] = listed;
  if (missing !== undefined) throw new Error(`the zip does not hold ${missing}, which its directory lists`);
  return files;
}

function joined(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
