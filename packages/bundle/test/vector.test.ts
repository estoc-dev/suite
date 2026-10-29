import { readFileSync } from "node:fs";
import { loadSignatures } from "@estoc/identity";
import { decodeObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The login object is the vector of @estoc/object, and the signature over it
// and its signer's identity object that of @estoc/identity. A change to the
// format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const objectText =
  '{"$describedBy":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";
const identityText =
  '{"$describedBy":{"$link":"sha256:c8a75f0349805a6afaa44d44ea0787c048310934de9dc8565788f0f003014be5"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const identityLink = "sha256:85ec27528b097c6c4b3f41dff76f54c3fe33fc47a7e50fb16878a994d8558065";
const signatureText =
  '{"$describedBy":{"$link":"sha256:28ba587a7be8e3258409b9f7dee927d8526051ca62e84e9f1950d956a10cc7d5"},' +
  '"identity":{"$link":"sha256:85ec27528b097c6c4b3f41dff76f54c3fe33fc47a7e50fb16878a994d8558065"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"6c029e975d7ae1f996fe751a8f0df35c068603921b63067ba9e66ddb18f08545' +
  'b36d69a64229c7ec4b0bb2ee45c44e7d79dca56de14b02d2076e318e70cd150e"}';
const signatureLink = "sha256:1be0b5f4f90cf9fa258693b05e8dc91fb7e85b5adfc794622c0d92e04f631c5e";

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
