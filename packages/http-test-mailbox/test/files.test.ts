import { readBundle, writeBundle, zipBundle } from "@estoc/bundle";
import { SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readBundleAt, writeBundleTo } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

const dir = await mkdtemp(join(tmpdir(), "http-test-mailbox-"));
afterAll(() => rm(dir, { recursive: true }));

const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello, Bob");
const signature = await signatures.sign(hello, alice);
const files = writeBundle(signature, [hello.bytes, signature.identity.bytes]);

let folders = 0;
const newFolder = () => join(dir, `bundle-${++folders}`);
const filesIn = async (folder: string) =>
  (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort();

describe("a bundle written to a folder", () => {
  it("is the files writeBundle gives, and reads back from there", async () => {
    const folder = newFolder();
    await writeBundleTo(folder, readBundle(files));
    expect(await filesIn(folder)).toEqual([...files.keys()].sort());
    const bundle = await readBundleAt(folder);
    expect(writeBundle({ bytes: bundle.root }, bundle.blobs())).toEqual(files);
  });

  it("again with other blobs, holds the blobs of both", async () => {
    const folder = newFolder();
    await writeBundleTo(folder, readBundle(writeBundle(signature, [hello.bytes])));
    await writeBundleTo(folder, readBundle(writeBundle(signature, [signature.identity.bytes])));
    const bundle = await readBundleAt(folder);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(bundle.get(signature.identity.link)).toEqual(signature.identity.bytes);
  });
});

describe("a bundle read from a path", () => {
  it("reads from a zip as from a folder", async () => {
    const zip = join(dir, "bundle.zip");
    await writeFile(zip, await zipBundle(files));
    const bundle = await readBundleAt(zip);
    expect(writeBundle({ bytes: bundle.root }, bundle.blobs())).toEqual(files);
  });

  it("is refused when the folder has no index.json", async () => {
    const folder = newFolder();
    await writeBundleTo(folder, readBundle(files));
    await rm(join(folder, "index.json"));
    await expect(readBundleAt(folder)).rejects.toThrow(/index\.json/);
  });
});
