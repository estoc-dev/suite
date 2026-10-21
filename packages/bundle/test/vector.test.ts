import { readFileSync } from "node:fs";
import { signatures } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

// The login object, the signature over it and its signer's identity object
// are the vector of @estoc/object. A change to the format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const objectText =
  '{"data":{"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"},' +
  '"schema":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}';
const objectLink = "sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80";
const identityText =
  '{"data":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"schema":"sha256:96f86a5c46a498f99672d0f99d5a2d8738699ae9e13dd22a66629c2bbb4ecbd1"}';
const identityLink = "sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc";
const signatureText =
  '{"data":{"identity":"sha256:5a5b174f0d65db60322fdf504eaad099064bb0046a102ef013d6dd171fc8eecc",' +
  '"object":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80",' +
  '"signature":"597af40ffd741eaf60009f405797ac722591b9f2f63966055722a409412bd00d' +
  '0ecfa9ae9d9c0e158301fe20a0b6aefdf25a6078117e4d524493212271b12608"},' +
  '"schema":"sha256:05b7d8cb16217903e90fbbae01bd0fdf157d10a9829fb22f2729c2e836495506"}';
const signatureLink = "sha256:b52314ccf85e50c4f7376d5adb825397c6b5961af5a58017857cd3cda577dacb";

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
