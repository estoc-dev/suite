import { readFileSync } from "node:fs";
import type { Link } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

// stored-by-python.zip holds these files as Python's zipfile writes them,
// without compression and with index.json last. A bundle does not validate
// these objects against their schemas or verify the signature, so the files
// stay fixed when those schemas change.
const objectText =
  '{"$schema":{"$link":"sha256:b53aad52f867b48f003b23eb3c6dbe7d6bf7163f6534ace22b4e95702d28cffd"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:31fe27a5b92be31ed7b457579de8e22967729dd773b329d795c64fbcaddd733d";
const rootText = '{"$schema":null,"language":"Estoc Schema"}';
const rootLink = "sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d";
const schemeSchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"name":{"type":"string"},"publicKeyLength":{"type":"integer"}},"title":"Key Scheme"}';
const schemeSchemaLink = "sha256:0429971ed4bab87c267154ed086ebbe56bacb52981412ccd2bd0ef2c47f6c8e9";
const ed25519SchemeText =
  '{"$schema":{"$link":"sha256:0429971ed4bab87c267154ed086ebbe56bacb52981412ccd2bd0ef2c47f6c8e9"},' +
  '"name":"ed25519","publicKeyLength":32}';
const ed25519SchemeLink = "sha256:f4630d0d0eb59054752ad9f5b865ffec1ccbba1c9ca6a37401bc037225ee1e6b";
const identitySchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"agents":{"items":{"type":"link"},"type":"array"},"at":{"type":"integer"},' +
  '"crisis":{"optional":true,"type":"boolean"},"prior":{"optional":true,"type":"link"},' +
  '"root":{"type":"link"}},"title":"Identity"}';
const identitySchemaLink = "sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c";
const keyText =
  '{"$schema":{"$link":"sha256:f4630d0d0eb59054752ad9f5b865ffec1ccbba1c9ca6a37401bc037225ee1e6b"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:6366025294b06e6779df029b48752ac7d6a1af6ea3ea1be54d9766f8376994c0";
const identityText =
  '{"$schema":{"$link":"sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c"},' +
  '"agents":[],"at":1767225600000,' +
  '"root":{"$link":"sha256:6366025294b06e6779df029b48752ac7d6a1af6ea3ea1be54d9766f8376994c0"}}';
const identityLink = "sha256:67eb35ab4931316777609b002dee0c7be5f18d778405f07ffa0f91eb1263238e";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"identity":{"type":"link"},"signature":{"type":"bytes"}},"title":"Signed Identity"}';
const signedIdentitySchemaLink = "sha256:fbbcca5737a5f22bf97e2bcdd5c3159250d28bb851a5bff0c255a2f1d89aede0";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:fbbcca5737a5f22bf97e2bcdd5c3159250d28bb851a5bff0c255a2f1d89aede0"},' +
  '"identity":{"$link":"sha256:67eb35ab4931316777609b002dee0c7be5f18d778405f07ffa0f91eb1263238e"},' +
  '"signature":"f816dbd7af17afed62e9c38664378e55ad1556204220bd81993e023cd7ccabe26bba4df40ecf6299e55e91f' +
  'aec40078b3c4118ff2bf0b44c997c0bfebb90e304"}';
const signedIdentityLink = "sha256:2ed1f38faad20cd41ab3e43017cd0796e9f42b230bc87799a2d9c58d48b109cf";
const signatureText =
  '{"$schema":{"$link":"sha256:94ddb53f18531a67946786be790171637eaa2884e2c293d0efdd1749e80f45c9"},' +
  '"object":{"$link":"sha256:31fe27a5b92be31ed7b457579de8e22967729dd773b329d795c64fbcaddd733d"},' +
  '"signature":"006c2b957e6132217ee7eefd2e8e04fef89492d37e6765ca2540266335fc54145e1448999113612fbdee6b6' +
  'a63f6cf509b1df448f95eb1714dc385e0ef0ebe0b00",' +
  '"signedIdentity":{"$link":"sha256:2ed1f38faad20cd41ab3e43017cd0796e9f42b230bc87799a2d9c58d48b109cf"}' +
  "}";
const signatureLink = "sha256:b5ecf9b1c7026e0d3f0c186649c3e62c8d1a03d774b668ba0cb16e736f28e06b";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const blobs = new Map<Link<unknown>, string>([
  [objectLink, objectText],
  [signedIdentityLink, signedIdentityText],
  [signedIdentitySchemaLink, signedIdentitySchemaText],
  [rootLink, rootText],
  [identityLink, identityText],
  [keyLink, keyText],
  [identitySchemaLink, identitySchemaText],
  [ed25519SchemeLink, ed25519SchemeText],
  [schemeSchemaLink, schemeSchemaText],
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
