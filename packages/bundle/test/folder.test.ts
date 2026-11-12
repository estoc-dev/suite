import { createHash } from "node:crypto";
import { type JsonObject, json, linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../src/index.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const hexOf = (bytes: Uint8Array) => linkOf(bytes).slice("sha256:".length);
const filesOf = (root: Uint8Array, ...blobs: Uint8Array[]) =>
  new Map([["index.json", root], ...blobs.map((blob) => [`blobs/sha256/${hexOf(blob)}`, blob] as const)]);

// The objects of the other packages are of est, so those of a folder are made with the encoding itself.
const note = linkOf(utf8("a schema"));
const objectOf = (data: JsonObject) => {
  const bytes = json.encode(json.object(data, note));
  return { bytes, link: linkOf(bytes) };
};
const hello = objectOf({ text: "hello" });
const reply = objectOf({ text: "a reply" });
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = objectOf({ links: [reply.link, hello.link, linkOf(image)].map((link) => ({ $link: link })) });

describe("a bundle in a folder", () => {
  it("is written as index.json and one file per blob named by its link, and reads back the same", () => {
    const blobs = [reply.bytes, hello.bytes, image];
    const files = writeBundle(root, blobs);
    expect([...files.keys()].sort()).toEqual(
      ["index.json", ...blobs.map((blob) => `blobs/sha256/${hexOf(blob)}`)].sort(),
    );
    const bundle = readBundle(files);
    expect(bundle.root).toEqual(root.bytes);
    expect(bundle.link).toBe(root.link);
    for (const blob of [root.bytes, ...blobs]) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it.each<[string, () => Map<string, Uint8Array>]>([
    ["no index.json", () => new Map([...filesOf(root.bytes, hello.bytes)].filter(([path]) => path !== "index.json"))],
    [
      "an index.json formatted by hand",
      () => filesOf(utf8(JSON.stringify(json.object({ text: "hello" }, note), null, 2))),
    ],
    ["an index.json that names no schema, which is bytes", () => filesOf(json.encode({ text: "hello" }))],
    ["an index.json that is not JSON", () => filesOf(image)],
    [
      "a blob that does not have the link its name says",
      () => new Map([...filesOf(root.bytes), [`blobs/sha256/${hexOf(hello.bytes)}`, image]]),
    ],
  ])("is refused with %s", (_, files) => {
    expect(() => readBundle(files())).toThrow();
  });

  it("is not written with a root that is not an object", () => {
    expect(() => writeBundle({ bytes: image }, [hello.bytes])).toThrow(/not an object/);
  });

  it.each<[string, Uint8Array]>([
    [".DS_Store", image],
    ["__MACOSX/._index.json", image],
    ["blobs/", new Uint8Array()],
    ["blobs/sha256/", new Uint8Array()],
    [`blobs/sha256/${hexOf(hello.bytes).toUpperCase()}`, hello.bytes],
    [`blobs/sha256/${hexOf(hello.bytes).slice(1)}`, hello.bytes],
    [`blobs/sha512/${createHash("sha512").update(hello.bytes).digest("hex")}`, hello.bytes],
  ])("reads with %s as no blob", (path, bytes) => {
    const bundle = readBundle(new Map([...filesOf(root.bytes), [path, bytes]]));
    expect(bundle.link).toBe(root.link);
    expect(bundle.get(linkOf(bytes))).toBeUndefined();
  });

  it("reads without blobs its root links to, which it does not get", () => {
    const bundle = readBundle(filesOf(root.bytes, reply.bytes));
    expect(bundle.get(reply.link)).toEqual(reply.bytes);
    expect(bundle.get(hello.link)).toBeUndefined();
    expect(bundle.get(linkOf(image))).toBeUndefined();
  });

  it("with only index.json is one object, and gets only that", () => {
    const bundle = readBundle(filesOf(hello.bytes));
    expect(bundle.link).toBe(hello.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(bundle.get(reply.link)).toBeUndefined();
  });

  it("reads the same with its root under blobs/ as well", () => {
    const bundle = readBundle(filesOf(root.bytes, root.bytes, hello.bytes));
    expect(bundle.link).toBe(root.link);
    expect(bundle.get(root.link)).toEqual(root.bytes);
  });

  it("lists its root and its blobs, each once, and no file that is not a blob", () => {
    const files = new Map([...filesOf(root.bytes, root.bytes, hello.bytes, image), [".DS_Store", image]]);
    expect([...readBundle(files).blobs()]).toEqual([root.bytes, hello.bytes, image]);
  });

  it.each<[string, (bytes: Uint8Array) => Uint8Array]>([
    ["arrays", (bytes) => bytes.slice()],
    ["Node Buffers", (bytes) => Buffer.from(bytes)],
  ])("keeps the bytes it checked when the given %s change afterwards", (_, given) => {
    const files = filesOf(given(root.bytes), given(reply.bytes), given(hello.bytes));
    const bundle = readBundle(files);
    for (const bytes of files.values()) bytes.fill(0x20);
    expect(bundle.root).toEqual(root.bytes);
    expect([...bundle.blobs()]).toEqual([root.bytes, reply.bytes, hello.bytes]);
  });
});
