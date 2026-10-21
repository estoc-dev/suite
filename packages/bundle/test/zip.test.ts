import { encodeObject, encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Zip, ZipPassThrough } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBundle, unzipBundle, writeBundle, zipBundle } from "../src/index.ts";

const pathOf = (blob: Uint8Array) => `blobs/${linkOf(blob).replace(":", "/")}`;
const sizeOf = (files: ReadonlyMap<string, Uint8Array>) => [...files.values()].reduce((size, bytes) => size + bytes.length, 0);

const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Note", type: "string" },
  defaultValidator,
);
const root = encodeObject(note, "a note");
const text = new TextEncoder().encode("a blob");
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const files = writeBundle(root, [text, image]);
const zeros = new Uint8Array(2 ** 20);

// A zip as a tool that streams writes it, which lets a path come twice.
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
  return new Uint8Array(Buffer.concat(chunks));
}

// Where the directory of a zip with no comment starts.
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

// The zip with the entries of another zip as its comment, which tools that
// read the directory pass over.
function hiding(zip: Uint8Array, other: Uint8Array): Uint8Array {
  const entries = other.subarray(0, directoryOf(other));
  const hidden = new Uint8Array(Buffer.concat([zip, entries]));
  new DataView(hidden.buffer).setUint16(zip.length - 2, entries.length, true);
  return hidden;
}

describe("a zipped bundle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("unzips to its files and reads as the same bundle", () => {
    const unzipped = unzipBundle(zipBundle(files));
    expect(unzipped).toEqual(files);
    const bundle = readBundle(unzipped);
    expect(bundle.link).toBe(root.link);
    for (const blob of [root.bytes, text, image]) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it("is the same bytes whenever and wherever it is zipped", () => {
    const zipped = (now: string, zone: string) => {
      vi.useFakeTimers({ now: new Date(now) });
      vi.stubEnv("TZ", zone);
      return zipBundle(files);
    };
    const zip = zipped("2026-10-21T12:00:00Z", "UTC");
    expect(zipped("2031-03-08T23:59:59Z", "Pacific/Kiritimati")).toEqual(zip);
    expect(zipped("2031-03-08T23:59:59Z", "Pacific/Pago_Pago")).toEqual(zip);
  });

  it("unzips only index.json and the blobs under blobs/sha256/", () => {
    const zip = zipBundle(
      new Map([
        ...files,
        ["../escape", image],
        ["/escape", image],
        ["blobs/sha256/", new Uint8Array()],
        [".DS_Store", image],
        ["__MACOSX/._index.json", zeros],
      ]),
    );
    expect(unzipBundle(zip, { bytes: sizeOf(files) })).toEqual(files);
  });

  it("unzips with its files in a folder as no bundle", () => {
    const zip = zipBundle(new Map([...files].map(([path, bytes]) => [`bundle/${path}`, bytes])));
    expect(unzipBundle(zip).size).toBe(0);
    expect(() => readBundle(unzipBundle(zip))).toThrow();
  });

  it("is refused when it unzips to more bytes than its limit, whatever sizes it gives", () => {
    const zip = zipBundle(new Map([[pathOf(zeros), zeros]]));
    expect(zip.length).toBeLessThan(2 ** 12);
    expect(() => unzipBundle(zip, { bytes: zeros.length - 1 })).toThrow(/more than/);
    const claimed = claimingOneByte(zip);
    expect(() => unzipBundle(claimed, { bytes: zeros.length - 1 })).toThrow(/more than/);
    expect(linkOf(unzipBundle(claimed).get(pathOf(zeros))!)).toBe(linkOf(zeros));
  });

  it("is refused when it has more entries than its limit", () => {
    const zip = zipBundle(files);
    expect(() => unzipBundle(zip, { entries: files.size - 1 })).toThrow(/more than/);
    expect(unzipBundle(zip, { entries: files.size })).toEqual(files);
  });

  it("is refused when it holds a path twice", () => {
    const entries = [...files];
    expect(unzipBundle(streamed(entries))).toEqual(files);
    expect(() => unzipBundle(streamed([...entries, [pathOf(text), text]]))).toThrow(/twice/);
    expect(() => unzipBundle(streamed([...entries, ["index.json", image]]))).toThrow(/twice/);
  });

  it("is refused when it is cut short anywhere", () => {
    const zip = zipBundle(files);
    for (let end = 0; end < zip.length; end++) expect(() => unzipBundle(zip.subarray(0, end))).toThrow();
  });

  it("is refused when the header of an entry its directory lists is damaged", () => {
    const damaged = zipBundle(files);
    const second = Buffer.from(damaged).indexOf(Buffer.from("PK\x03\x04", "latin1"), 1);
    damaged[second + 3] = 0x05;
    expect(() => unzipBundle(damaged)).toThrow(/directory/);
  });

  it("is refused when it holds an entry that its directory does not list", () => {
    const another = encodeObject(note, "another note");
    const zip = hiding(zipBundle(files), zipBundle(new Map([["index.json", another.bytes]])));
    expect(() => unzipBundle(zip)).toThrow(/directory/);
  });
});
