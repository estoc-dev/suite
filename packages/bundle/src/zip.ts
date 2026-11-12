import type { Bytes } from "@estoc/object";
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js/index-native.js";
import { BLOB, type Bundle, ROOT, readBundle, writeBundle } from "./bundle.ts";
import { joined } from "./bytes.ts";

const LIMITS = { bytes: 64 * 2 ** 20, entries: 10_000 };
// Stored, and DEFLATE.
const METHODS = [0, 8];

/**
 * Zips the files of a bundle as they are, `index.json` at the top of the zip, compressed with
 * DEFLATE unless `compress` is false.
 *
 * Every entry is dated 1980-02-01, so that a zip does not tell when or in which time zone it was
 * made. The date is in local time, which is what a zip records. The earliest date a zip can hold is
 * a month before, and zip.js raises a date below it to it as it stood in the time zone zip.js was
 * loaded in; a month is clear of that in any time zone.
 */
export async function zipBundle(
  files: ReadonlyMap<string, Uint8Array>,
  { compress = true }: { readonly compress?: boolean } = {},
): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), {
    level: compress ? 6 : 0,
    lastModDate: new Date(1980, 1, 1),
    // An extended timestamp is in UTC, which a date in local time turns into
    // the time zone.
    extendedTimestamp: false,
    // Each header gives the sizes of its entry, so that a reader going from
    // header to header knows them before it unzips the entry.
    dataDescriptor: false,
    // The DEFLATE that zip.js carries, rather than the platform's, so that the
    // same files zip to the same bytes in a browser and in Node.
    useCompressionStream: false,
    useWebWorkers: false,
  });
  for (const [path, bytes] of files) await zip.add(path, new Uint8ArrayReader(bytes));
  return zip.close();
}

/**
 * Unzips the files of a bundle into memory: `index.json` and the blobs under `blobs/sha256/`, as
 * the directory at the end of the zip lists them. Other entries are not unzipped, so a path such as
 * `../` is not written anywhere. `limits` are 64 MiB unzipped and 10,000 entries unless given.
 *
 * @throws when the zip holds a path twice, or goes over `limits`.
 * @throws when an entry it unzips is compressed other than with DEFLATE.
 * @throws when the header of an entry it unzips is not where the directory says, or gives another
 *   method, size or CRC.
 * @throws when an entry does not unzip to the size and CRC the directory gives.
 */
export async function unzipBundle(
  zip: Uint8Array,
  limits: { readonly bytes?: number; readonly entries?: number } = {},
): Promise<Map<string, Uint8Array>> {
  const { bytes = LIMITS.bytes, entries = LIMITS.entries } = limits;
  // zip.js hands an entry to be unzipped in pieces of this size, and DEFLATE
  // makes at most about a thousand times its size, so a piece unzips to a few
  // MiB at most before what comes out is counted. The size is a setting shared
  // by all of zip.js in the program and read for each entry. It is set at the
  // start of each unzip, over any set before, and holds as long as no other
  // code changes it while the unzip runs.
  configure({ chunkSize: 4096 });
  const abort = new AbortController();
  const reader = new ZipReader(new Uint8ArrayReader(zip), {
    // A damaged blob does not have the link its name says, but a damaged
    // index.json can still be an object.
    checkCrc32: true,
    // Paths are matched exactly below, and an entry under any other path is
    // passed over rather than refused.
    filenameValidation: "tolerant",
    signal: abort.signal,
    useWebWorkers: false,
  });
  const files = new Map<string, Uint8Array>();
  const paths = new Set<string>();
  let unzippedBytes = 0;
  for await (const entry of reader.getEntriesGenerator()) {
    const path = entry.filename;
    if (paths.has(path)) throw new Error(`the zip holds ${path} twice`);
    paths.add(path);
    if (paths.size > entries) throw new Error(`the zip has more than ${entries} entries`);
    if (entry.directory || (path !== ROOT && !BLOB.test(path))) continue;
    // zip.js also unzips Deflate64, and any method registered with it, a piece
    // of which can make far more than a thousand times its size.
    if (!METHODS.includes(entry.compressionMethod))
      throw new Error(`the zip compresses ${path} other than with DEFLATE`);
    const chunks: Uint8Array[] = [];
    await entry.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          // Counted as they come out, since the sizes a zip gives can be false.
          // The reader is aborted before the error is thrown, so that zip.js
          // keeps the error when it comes at the last chunk.
          unzippedBytes += chunk.length;
          if (unzippedBytes > bytes) abort.abort(new Error(`the zip unzips to more than ${bytes} bytes`));
          abort.signal.throwIfAborted();
          chunks.push(chunk);
        },
      }),
    );
    files.set(path, joined(chunks));
  }
  return files;
}

/** The zip, without compression, of the folder of `root` and `blobs`, a bundle of JSON objects. */
export function packBundle(
  root: { readonly bytes: Bytes<unknown> },
  blobs: Iterable<Bytes<unknown>>,
): Promise<Uint8Array> {
  return zipBundle(writeBundle(root, blobs), { compress: false });
}

/**
 * Reads a bundle that arrived as a zip. A zip without compression is larger than its files, so
 * limiting the files to the size of the zip refuses no zip that `packBundle` writes, while a
 * compressed one could otherwise unzip to far more than arrived.
 *
 * @throws when the files come to more bytes than the zip, or when `unzipBundle` or `readBundle`
 *   refuses it.
 */
export async function unpackBundle(zip: Uint8Array): Promise<Bundle> {
  return readBundle(await unzipBundle(zip, { bytes: zip.length }));
}
