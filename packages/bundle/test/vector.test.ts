import { readFileSync } from "node:fs";
import { decodeObject, loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The login object, the signature over it and its signer's identity object
// are the vector of @estoc/object. A change to the format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const objectText =
  '{"$type":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de";
const identityText =
  '{"$type":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"}';
const identityLink = "sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c";
const signatureText =
  '{"$type":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:3d52c9daa7ce3a7b07d4f155e33b08374b14e82f3d05c14f718d64d3552d6e1c"},' +
  '"object":{"$link":"sha256:5fc34eb199031340371d48949ef89f64587acce9763e6bf38a6cd7d6b80b31de"},' +
  '"signature":"13ca07ea915690d48f8ef2689f836614390bf782cd2202ea4aa4e520f1b03b7b' +
  'f7f0fed866dac80182832deed515a44ed0deee3b0d0325f1aca6bb03e97f2c09"}';
const signatureLink = "sha256:07339b1193cde4d8f60205accc36426b14dd6879e607ab95971a2738be4108fb";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const files = new Map([
  ["index.json", signatureText],
  [`blobs/sha256/${objectLink.slice(7)}`, objectText],
  [`blobs/sha256/${identityLink.slice(7)}`, identityText],
]);

describe("a bundle whose root is a signature over a login object, carrying the object and the signer's identity", () => {
  it("writes to fixed files", async () => {
    const read = decodeObject(utf8(signatureText), signatures.schema);
    const signature = await signatures.verify(read, new Map([[identityLink, utf8(identityText)]]));
    const written = writeBundle(signature, [utf8(objectText), signature.identity.bytes]);
    expect(new Map([...written].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
  });

  it("reads from those files with the root's link, and gets each blob by its link", () => {
    const bundle = readBundle(new Map([...files].map(([path, text]) => [path, utf8(text)])));
    expect(text(bundle.root)).toBe(signatureText);
    expect(bundle.link).toBe(signatureLink);
    expect(text(bundle.get(signatureLink))).toBe(signatureText);
    expect(text(bundle.get(objectLink))).toBe(objectText);
    expect(text(bundle.get(identityLink))).toBe(identityText);
  });

  it("unzips to those files from a zip that another tool made", async () => {
    const zip = new Uint8Array(readFileSync(new URL("stored-by-python.zip", import.meta.url)));
    const unzipped = await unzipBundle(zip);
    expect(new Map([...unzipped].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
    expect(readBundle(unzipped).link).toBe(signatureLink);
  });
});
