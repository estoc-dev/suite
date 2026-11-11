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
const keySchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"publicKey":{"type":"bytes"}},"title":"ed25519"}';
const keySchemaLink = "sha256:9d398d391977d1ab62a9adda75a06ed3e46ec763145bcbc8b289f0bb306b7c33";
const identitySchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"agents":{"items":{"type":"link"},"type":"array"},"at":{"type":"integer"},' +
  '"crisis":{"optional":true,"type":"boolean"},"prior":{"optional":true,"type":"link"},' +
  '"root":{"type":"link"}},"title":"Identity"}';
const identitySchemaLink = "sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c";
const keyText =
  '{"$schema":{"$link":"sha256:9d398d391977d1ab62a9adda75a06ed3e46ec763145bcbc8b289f0bb306b7c33"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:574935ed4a368b05010e2165eb1e8ff3cb59e8ad4cb4be87670b97507b4a00c5";
const identityText =
  '{"$schema":{"$link":"sha256:f1401b9ac1022fb4bc0cfbe87324c430012d74056eed9373ff9369b1f10fe08c"},' +
  '"agents":[],"at":1767225600000,' +
  '"root":{"$link":"sha256:574935ed4a368b05010e2165eb1e8ff3cb59e8ad4cb4be87670b97507b4a00c5"}}';
const identityLink = "sha256:d57a0e44dda2bd678fc6d5346bb5d7d837185c34779a68094afb96b15072f2fb";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:854038464fe14f61bc8c9de12ecf81566d48c55b18223f38ba49e5d3c4d04d9d"},' +
  '"fields":{"identity":{"type":"link"},"signature":{"type":"bytes"}},"title":"Signed Identity"}';
const signedIdentitySchemaLink = "sha256:fbbcca5737a5f22bf97e2bcdd5c3159250d28bb851a5bff0c255a2f1d89aede0";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:fbbcca5737a5f22bf97e2bcdd5c3159250d28bb851a5bff0c255a2f1d89aede0"},' +
  '"identity":{"$link":"sha256:d57a0e44dda2bd678fc6d5346bb5d7d837185c34779a68094afb96b15072f2fb"},' +
  '"signature":"1dede05f2ef1096ff7ce97c11e16ab058eca572965caa8629cad571fee18486a65906775a816967d79e2d73' +
  '5aa181b63e69231bf0df05784aed5f3ad7438d30b"}';
const signedIdentityLink = "sha256:c7c2129da8179e9299ddb612d62952e70d01d030b0e53ed0f2f4624b4dcb4f48";
const signatureText =
  '{"$schema":{"$link":"sha256:94ddb53f18531a67946786be790171637eaa2884e2c293d0efdd1749e80f45c9"},' +
  '"object":{"$link":"sha256:31fe27a5b92be31ed7b457579de8e22967729dd773b329d795c64fbcaddd733d"},' +
  '"signature":"00933424ffbb951043a6262a84ba2ec58855f8e9eedb55fb45d611ca9c6640a57b903134e01dab47ada7bf4' +
  '34d172e933958080e39f710a92fa026e10956356107",' +
  '"signedIdentity":{"$link":"sha256:c7c2129da8179e9299ddb612d62952e70d01d030b0e53ed0f2f4624b4dcb4f48"}' +
  "}";
const signatureLink = "sha256:5d9439d257130d9dc57a02fba827610d1117223419d7d0ceb2605753d93cad92";

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
