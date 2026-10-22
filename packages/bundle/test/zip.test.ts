import { constants, deflateRawSync } from "node:zlib";
import { encodeObject, encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import {
  configure,
  resetConfiguration,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import { Inflate, Zip, ZipPassThrough, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBundle, unzipBundle, writeBundle, zipBundle } from "../src/index.ts";

const pathOf = (blob: Uint8Array) => `blobs/${linkOf(blob).replace(":", "/")}`;
const sizeOf = (files: ReadonlyMap<string, Uint8Array>) => [...files.values()].reduce((size, bytes) => size + bytes.length, 0);
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Note", type: "string" },
  defaultValidator,
);
const root = encodeObject(note, "a note");
const another = encodeObject(note, "another note");
const text = new TextEncoder().encode("a blob");
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const files = writeBundle(root, [text, image]);
const zeros = new Uint8Array(2 ** 20);

// A zip as a tool that streams writes it, which lets a path come twice and
// gives the sizes of an entry after its bytes.
function streamed(entries: [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [path, bytes] of entries) {
    const file = new ZipPassThrough(path);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return concat(...chunks);
}

// The fixtures have no zip comment, so the end record is at the end.
const directoryOf = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset).getUint32(zip.length - 6, true);

// The zip of one entry, saying in both of its headers that the entry unzips
// to one byte.
function claimingOneByte(zip: Uint8Array): Uint8Array {
  const claimed = zip.slice();
  const view = new DataView(claimed.buffer);
  view.setUint32(22, 1, true);
  view.setUint32(directoryOf(zip) + 24, 1, true);
  return claimed;
}

// The zip with the entry under `path` compressed with `method`, as both of its
// headers say.
function compressedWith(zip: Uint8Array, path: string, method: number): Uint8Array {
  const patched = zip.slice();
  const view = new DataView(patched.buffer);
  let at = directoryOf(zip);
  for (let i = 0; i < view.getUint16(zip.length - 12, true); i++) {
    const nameLength = view.getUint16(at + 28, true);
    if (Buffer.from(patched.subarray(at + 46, at + 46 + nameLength)).toString() === path) {
      view.setUint16(at + 10, method, true);
      view.setUint16(view.getUint32(at + 42, true) + 8, method, true);
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return patched;
}

// The zip with the entries of another zip as its comment.
function hiding(zip: Uint8Array, other: Uint8Array): Uint8Array {
  const entries = other.subarray(0, directoryOf(other));
  const hidden = concat(zip, entries);
  new DataView(hidden.buffer).setUint16(zip.length - 2, entries.length, true);
  return hidden;
}

// The zip of one entry, with the one entry of another zip before it, whose
// header holds the entry as an extra field. A reader that goes from header to
// header passes over the entry and comes to the other entry's bytes.
function shadowed(zip: Uint8Array, other: Uint8Array): Uint8Array {
  const directory = directoryOf(zip);
  const entry = zip.subarray(0, directory);
  const otherView = new DataView(other.buffer, other.byteOffset);
  const nameEnd = 30 + otherView.getUint16(26, true);
  const header = other.slice(0, nameEnd);
  const bytes = other.subarray(nameEnd + otherView.getUint16(28, true), directoryOf(other));
  const field = new Uint8Array(4);
  new DataView(field.buffer).setUint16(0, 0xcafe, true);
  new DataView(field.buffer).setUint16(2, entry.length, true);
  new DataView(header.buffer).setUint16(28, field.length + entry.length, true);
  const end = zip.slice(directory);
  const endView = new DataView(end.buffer);
  endView.setUint32(42, header.length + field.length, true);
  endView.setUint32(end.length - 6, header.length + field.length + entry.length + bytes.length, true);
  return concat(header, field, entry, bytes, end);
}

// A zip whose blob unzips to `mib` MiB of zeros, 4 GiB unless given, saying
// that it unzips to `claimed` bytes. Each MiB after the first is the same
// DEFLATE block of about a KiB, which repeats the zeros before it.
async function zeroBomb(claimed: number, mib = 4096): Promise<Uint8Array> {
  const flush = { finishFlush: constants.Z_SYNC_FLUSH, level: 9 };
  const first = deflateRawSync(zeros, flush);
  const next = deflateRawSync(zeros, { ...flush, dictionary: zeros.subarray(0, 2 ** 15) });
  const last = new Uint8Array([0x03, 0x00]);
  const deflated = concat(first, ...Array<Uint8Array>(mib - 1).fill(next), last);
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add("index.json", new Uint8ArrayReader(root.bytes));
  await zip.add(pathOf(zeros), new Uint8ArrayReader(deflated), {
    passThrough: true,
    compressionMethod: 8,
    uncompressedSize: claimed,
    signature: 0,
  });
  return zip.close();
}

// A DEFLATE that unzips each piece it is handed whole, as the one zip.js
// carries does, and counts what it makes.
class Whole extends TransformStream<Uint8Array, Uint8Array> {
  static made = 0;

  constructor() {
    let inflate: Inflate;
    super({
      start(controller) {
        inflate = new Inflate((data) => {
          Whole.made += data.length;
          controller.enqueue(data);
        });
      },
      transform(chunk) {
        inflate.push(chunk);
      },
      flush() {
        inflate.push(new Uint8Array(), true);
      },
    });
  }
}

describe("a zipped bundle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetConfiguration();
  });

  it("unzips to its files and reads as the same bundle", async () => {
    const unzipped = await unzipBundle(await zipBundle(files));
    expect(unzipped).toEqual(files);
    const bundle = readBundle(unzipped);
    expect(bundle.link).toBe(root.link);
    for (const blob of [root.bytes, text, image]) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it("without compression holds its files as they are, and unzips to them", async () => {
    const large = writeBundle(root, [zeros]);
    const stored = await zipBundle(large, { compress: false });
    expect(stored.length).toBeGreaterThan(sizeOf(large));
    expect((await zipBundle(large)).length).toBeLessThan(sizeOf(large));
    expect(await unzipBundle(stored)).toEqual(large);
  });

  it("is the same bytes whenever and wherever it is zipped", async () => {
    const zipped = (now: string, zone: string) => {
      vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
      vi.stubEnv("TZ", zone);
      return zipBundle(files);
    };
    const zip = await zipped("2026-10-21T12:00:00Z", "UTC");
    expect(await zipped("2031-03-08T23:59:59Z", "Pacific/Auckland")).toEqual(zip);
    expect(await zipped("2031-03-08T23:59:59Z", "Pacific/Pago_Pago")).toEqual(zip);
  });

  it("unzips only index.json and the blobs under blobs/sha256/", async () => {
    const zip = await zipBundle(
      new Map([
        ...files,
        ["../escape", image],
        ["/escape", image],
        ["blobs/sha256/", new Uint8Array()],
        [".DS_Store", image],
        ["__MACOSX/._index.json", zeros],
      ]),
    );
    expect(await unzipBundle(zip, { bytes: sizeOf(files) })).toEqual(files);
  });

  it("unzips with its files in a folder as no bundle", async () => {
    const zip = await zipBundle(new Map([...files].map(([path, bytes]) => [`bundle/${path}`, bytes])));
    const unzipped = await unzipBundle(zip);
    expect(unzipped.size).toBe(0);
    expect(() => readBundle(unzipped)).toThrow();
  });

  it("unzips a blob that is itself a zip, from a zip written as a stream", async () => {
    const nested = writeBundle(root, [await zipBundle(files)]);
    expect(await unzipBundle(streamed([...nested]))).toEqual(nested);
  });

  it("unzips the entries its directory lists, whatever its comment holds", async () => {
    const zip = hiding(await zipBundle(files), await zipBundle(new Map([["index.json", another.bytes]])));
    expect(await unzipBundle(zip)).toEqual(files);
  });

  it("unzips the entry its directory lists, where a reader going from header to header finds another", async () => {
    const listed = new Map([["index.json", root.bytes]]);
    const zip = shadowed(await zipBundle(listed), await zipBundle(new Map([["index.json", another.bytes]])));
    expect(await unzipBundle(zip)).toEqual(listed);
  });

  it("is refused when it unzips to more bytes than its limit", async () => {
    const zip = await zipBundle(new Map([[pathOf(zeros), zeros]]));
    await expect(unzipBundle(zip, { bytes: zeros.length - 1 })).rejects.toThrow(/more than/);
    const unzipped = await unzipBundle(zip, { bytes: zeros.length });
    expect(linkOf(unzipped.get(pathOf(zeros))!)).toBe(linkOf(zeros));
  });

  it("is refused at its limit when it unzips to a thousand times its size, whatever size it gives", async () => {
    for (const zip of [await zeroBomb(2 ** 32), await zeroBomb(1)]) {
      expect(zip.length).toBeLessThan(5 * 2 ** 20);
      await expect(unzipBundle(zip, { bytes: 2 ** 10 })).rejects.toThrow();
      await expect(unzipBundle(zip)).rejects.toThrow();
    }
  });

  it("is refused at its limit with a few MiB unzipped, where each piece is unzipped whole", async () => {
    configure({ useCompressionStream: false, DecompressionStreamFallback: Whole });
    await expect(unzipBundle(await zeroBomb(2 ** 26, 64), { bytes: 2 ** 10 })).rejects.toThrow(/more than/);
    expect(Whole.made).toBeLessThan(32 * 2 ** 20);
  });

  it("is refused when its index.json or a blob is compressed other than with DEFLATE", async () => {
    const zip = await zipBundle(new Map([...files, [".DS_Store", text]]));
    // The DEFLATE that zipped these few bytes is also Deflate64, method 9,
    // which unzips them the same.
    expect(await unzipBundle(compressedWith(zip, ".DS_Store", 9))).toEqual(files);
    await expect(unzipBundle(compressedWith(zip, pathOf(text), 9))).rejects.toThrow(/DEFLATE/);
    await expect(unzipBundle(compressedWith(zip, "index.json", 9))).rejects.toThrow(/DEFLATE/);
  });

  it("is refused when an entry does not unzip to the size it gives", async () => {
    const zip = claimingOneByte(await zipBundle(new Map([[pathOf(zeros), zeros]])));
    await expect(unzipBundle(zip)).rejects.toThrow();
  });

  it("is refused when it has more entries than its limit", async () => {
    const zip = await zipBundle(files);
    await expect(unzipBundle(zip, { entries: files.size - 1 })).rejects.toThrow(/more than/);
    expect(await unzipBundle(zip, { entries: files.size })).toEqual(files);
  });

  it("unzips with as many entries as its limit allows", { timeout: 20_000 }, async () => {
    const blobs = Array.from({ length: 9_999 }, (_, i) => new TextEncoder().encode(`blob ${i}`));
    // fflate zips this many entries several times faster.
    const zip = zipSync(Object.fromEntries(writeBundle(root, blobs)));
    const bundle = readBundle(await unzipBundle(zip));
    for (const blob of blobs) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it("is refused when it holds a path twice", async () => {
    const entries = [...files];
    expect(await unzipBundle(streamed(entries))).toEqual(files);
    await expect(unzipBundle(streamed([...entries, [pathOf(text), text]]))).rejects.toThrow(/twice/);
    await expect(unzipBundle(streamed([...entries, ["index.json", image]]))).rejects.toThrow(/twice/);
  });

  it("is refused when it is cut short anywhere", async () => {
    const zip = await zipBundle(files);
    for (let end = 0; end < zip.length; end++) await expect(unzipBundle(zip.subarray(0, end))).rejects.toThrow();
  });

  it("is refused when the header of an entry its directory lists is damaged", async () => {
    const damaged = await zipBundle(files);
    const second = Buffer.from(damaged).indexOf("PK\x03\x04", 1, "latin1");
    damaged[second + 3] = 0x05;
    await expect(unzipBundle(damaged)).rejects.toThrow();
  });

  it("is refused when its index.json is damaged into another object", async () => {
    const stored = zipSync(Object.fromEntries(files), { level: 0 });
    const damaged = stored.slice();
    damaged[Buffer.from(stored).indexOf("a note") + 2] = "b".charCodeAt(0);
    expect(await unzipBundle(stored)).toEqual(files);
    await expect(unzipBundle(damaged)).rejects.toThrow();
  });
});
