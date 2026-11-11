import { readFileSync } from "node:fs";
import type { Link } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

// stored-by-python.zip holds these files as Python's zipfile writes them,
// without compression and with index.json last. A bundle does not validate
// these objects against their schemas or verify the signature, so the files
// stay fixed when those schemas change.
const objectText =
  '{"$schema":{"$link":"sha256:655d8f8d7bea600efd6769e192618864ed04d1788cfd5ebfa00eb3d0284256ed"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:4ec5d3c3ffe5bea83088c2a822c793c290e2e5ee52e8cb1b672ad07009f7a830";
const keySchemaText = '{"fields":{"publicKey":{"type":"bytes"}},"title":"ed25519"}';
const keySchemaLink = "sha256:62dd67062c5c6f556b735a493b10a3a1ae4c27fc8e455a820e39fdd2b3f17dc4";
const identitySchemaText =
  '{"fields":{"agents":{"items":{"type":"link"},"type":"array"},"at":{"type":"integer"},' +
  '"crisis":{"optional":true,"type":"boolean"},"prior":{"optional":true,"type":"link"},' +
  '"root":{"type":"link"}},"title":"Identity"}';
const identitySchemaLink = "sha256:dfecb045e117ef19e5b70e67681d952a8ddb3d64dd8151814439681439a33c16";
const keyText =
  '{"$schema":{"$link":"sha256:62dd67062c5c6f556b735a493b10a3a1ae4c27fc8e455a820e39fdd2b3f17dc4"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:c4c990fb3b9d9dda34236d67e460a0ea36558901945d68b0e3555dbd07374003";
const identityText =
  '{"$schema":{"$link":"sha256:dfecb045e117ef19e5b70e67681d952a8ddb3d64dd8151814439681439a33c16"},' +
  '"agents":[],"at":1767225600000,' +
  '"root":{"$link":"sha256:c4c990fb3b9d9dda34236d67e460a0ea36558901945d68b0e3555dbd07374003"}}';
const identityLink = "sha256:7012afca3dc93c65f5215db267d076afd1e2520a0c26275a653e070eb5624a2e";
const signedIdentitySchemaText =
  '{"fields":{"identity":{"type":"link"},"signature":{"type":"bytes"}},"title":"Signed Identity"}';
const signedIdentitySchemaLink = "sha256:ec47d3a3bde0aaf7a7a830af0b7d4514c082ee21c9b7e53fa2c5c024af9b5b11";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:ec47d3a3bde0aaf7a7a830af0b7d4514c082ee21c9b7e53fa2c5c024af9b5b11"},' +
  '"identity":{"$link":"sha256:7012afca3dc93c65f5215db267d076afd1e2520a0c26275a653e070eb5624a2e"},' +
  '"signature":"9a995a77a0e87dc83208d03305bcd745a3c8fa03c3c3611151bf8d86947822a926c6daf9f47fe5e5441' +
  '018d4e8adc60c76e9f8104834e5ea60883e428d7f9f08"}';
const signedIdentityLink = "sha256:eeb35f055172829f08fa78d37b8f5a109f71543d8183bde3958f4eee4b84498c";
const signatureText =
  '{"$schema":{"$link":"sha256:8f342427f55f642ffd678fc9389ebeb105030eed6a76e512a42c1cf70b3e7b8d"},' +
  '"object":{"$link":"sha256:4ec5d3c3ffe5bea83088c2a822c793c290e2e5ee52e8cb1b672ad07009f7a830"},' +
  '"signature":"0069a0e3581beba5cddbefb5544900504532319ee9a5232f06fb5fd38bc288cafa011764cff738d9dc6' +
  'bdcb1984e87540a34595aea6ba8f1fd5489b88b1383b60f",' +
  '"signedIdentity":{"$link":"sha256:eeb35f055172829f08fa78d37b8f5a109f71543d8183bde3958f4eee4b8449' +
  '8c"}}';
const signatureLink = "sha256:b368ee482eb2811bff74df5132cda60a51c8c0038acd880b9988fda330fc38da";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const blobs = new Map<Link<unknown>, string>([
  [objectLink, objectText],
  [signedIdentityLink, signedIdentityText],
  [signedIdentitySchemaLink, signedIdentitySchemaText],
  [identityLink, identityText],
  [keyLink, keyText],
  [identitySchemaLink, identitySchemaText],
  [keySchemaLink, keySchemaText],
]);
const files = new Map([
  ["index.json", signatureText],
  ...[...blobs].map(([link, text]) => [`blobs/sha256/${link.slice(7)}`, text] as const),
]);

describe("a bundle whose root is a signature over a login object, carrying the object and the signer's signed identity", () => {
  it("writes to fixed files", () => {
    const writtenFiles = writeBundle({ bytes: utf8(signatureText) }, [...blobs.values()].map(utf8));
    expect(new Map([...writtenFiles].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
  });

  it("reads from those files with the root's link, and gets each blob by its link", () => {
    const bundle = readBundle(new Map([...files].map(([path, text]) => [path, utf8(text)])));
    expect(text(bundle.root)).toBe(signatureText);
    expect(bundle.link).toBe(signatureLink);
    expect(text(bundle.get(signatureLink))).toBe(signatureText);
    for (const [link, blob] of blobs) expect(text(bundle.get(link))).toBe(blob);
  });

  it("unzips to those files from a zip that another tool made", async () => {
    const zip = new Uint8Array(readFileSync(new URL("stored-by-python.zip", import.meta.url)));
    const unzippedFiles = await unzipBundle(zip);
    expect(new Map([...unzippedFiles].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
    expect(readBundle(unzippedFiles).link).toBe(signatureLink);
  });
});
