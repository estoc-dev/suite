import { createHash } from "node:crypto";
import { identityToJson, SoftwareSigner } from "@estoc/identity";
import { decodeSignature, encodeJson, encodeObject, encodeSchema, linkOf, sign, type JsonObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);
const hexOf = (bytes: Uint8Array) => linkOf(bytes).slice("sha256:".length);
const filesOf = (root: Uint8Array, ...blobs: Uint8Array[]) =>
  new Map([["index.json", root], ...blobs.map((blob) => [`blobs/sha256/${hexOf(blob)}`, blob] as const)]);
const rewritten = (bytes: Uint8Array, change: (fields: JsonObject) => JsonObject) =>
  encodeJson(change(JSON.parse(new TextDecoder().decode(bytes)) as JsonObject));

const note = await encodeSchema({ $schema: DRAFT, title: "Note", type: "string" }, defaultValidator);
const links = await encodeSchema(
  { $schema: DRAFT, title: "Links", type: "array", items: { $ref: "https://estoc.dev/schema/link" } },
  defaultValidator,
);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hello = encodeObject(note, "hello");
const signature = await sign(hello, alice);
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = encodeObject(links, [signature.link, hello.link, linkOf(image)]);

describe("a bundle", () => {
  it("is written as index.json and one file per blob named by its link, and reads back the same", () => {
    const blobs = [signature.bytes, hello.bytes, image];
    const files = writeBundle(root, blobs);
    expect([...files.keys()].sort()).toEqual(["index.json", ...blobs.map((blob) => `blobs/sha256/${hexOf(blob)}`)].sort());
    const bundle = readBundle(files);
    expect(bundle.root).toEqual(root.bytes);
    expect(bundle.link).toBe(root.link);
    for (const blob of [root.bytes, ...blobs]) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it.each<[string, () => Map<string, Uint8Array>]>([
    ["no index.json", () => new Map([...filesOf(root.bytes, hello.bytes)].filter(([path]) => path !== "index.json"))],
    ["an index.json formatted by hand", () => filesOf(utf8(JSON.stringify({ data: "hello", schema: note.link }, null, 2)))],
    ["an index.json that is a signature", () => filesOf(signature.bytes, hello.bytes)],
    ["an index.json that is a schema", () => filesOf(note.bytes)],
    ["an index.json that is not JSON", () => filesOf(image)],
    ["a blob that does not have the link its name says", () => new Map([...filesOf(root.bytes), [`blobs/sha256/${hexOf(hello.bytes)}`, image]])],
  ])("is refused with %s", (_, files) => {
    expect(() => readBundle(files())).toThrow();
  });

  it("reads with a signature that does not verify or whose scheme is unknown, as bytes", () => {
    const changed = rewritten(signature.bytes, (fields) => {
      const hex = fields.signature as string;
      return { ...fields, signature: `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}` };
    });
    const { publicKey } = identityToJson(alice.identity);
    const unknown = rewritten(signature.bytes, (fields) => ({ ...fields, identity: { publicKey, scheme: "a-later-scheme" } }));
    for (const blob of [changed, unknown]) {
      expect(() => decodeSignature(blob)).toThrow();
      expect(readBundle(filesOf(root.bytes, blob)).get(linkOf(blob))).toEqual(blob);
    }
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
    const bundle = readBundle(filesOf(root.bytes, signature.bytes));
    expect(bundle.get(signature.link)).toEqual(signature.bytes);
    expect(bundle.get(hello.link)).toBeUndefined();
    expect(bundle.get(linkOf(image))).toBeUndefined();
  });

  it("with only index.json is one object, and gets only that", () => {
    const bundle = readBundle(filesOf(hello.bytes));
    expect(bundle.link).toBe(hello.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(bundle.get(signature.link)).toBeUndefined();
  });

  it("reads the same with its root under blobs/ as well", () => {
    const bundle = readBundle(filesOf(root.bytes, root.bytes, hello.bytes));
    expect(bundle.link).toBe(root.link);
    expect(bundle.get(root.link)).toEqual(root.bytes);
  });

  it("keeps the bytes it checked when the given arrays change afterwards", () => {
    const files = filesOf(root.bytes.slice(), hello.bytes.slice());
    const bundle = readBundle(files);
    for (const bytes of files.values()) bytes.fill(0x20);
    expect(bundle.root).toEqual(root.bytes);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
  });
});
