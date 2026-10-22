import { readFileSync } from "node:fs";
import { loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The login object, the signature over it and its signer's identity object
// are the vector of @estoc/object. A change to the format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const objectText =
  '{"data":{"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"},' +
  '"schema":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}}';
const objectLink = "sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52";
const identityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":{"$link":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}}';
const identityLink = "sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53";
const signatureText =
  '{"data":{"identity":{"$link":"sha256:62abc6480cbadc8179cf05e5b19faa7e3db3e7ef531bccb66a22988d56c87e53"},' +
  '"object":{"$link":"sha256:5d30573d533225e8de6a606e0531506022e16419cad6b1f735b21d3fffcc4d52"},' +
  '"signature":"bc44d93c9596131d6723e9c749b910648918af6a3cdb6e4c9e493f62be3b1edf' +
  '84159319aa8ec050291690c57ef99ffb788d7c86d90fb3851bed43ce0d11aa02"},' +
  '"schema":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"}}';
const signatureLink = "sha256:b6799e6f181e8d164164bef5e33aec18bf7cc8c7e152d58652c0d0b45ccacd5f";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const files = new Map([
  ["index.json", signatureText],
  [`blobs/sha256/${objectLink.slice(7)}`, objectText],
  [`blobs/sha256/${identityLink.slice(7)}`, identityText],
]);

describe("a bundle whose root is a signature over a login object, carrying the object and the signer's identity", () => {
  it("writes to fixed files", () => {
    const signature = signatures.decode(utf8(signatureText), new Map([[identityLink, utf8(identityText)]]));
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
