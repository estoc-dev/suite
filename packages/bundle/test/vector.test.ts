import { readFileSync } from "node:fs";
import type { Link } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

// stored-by-python.zip holds these files as Python's zipfile writes them,
// without compression and with index.json last. A bundle does not validate
// these objects against their schemas or verify the signature, so the files
// stay fixed when those schemas change.
const objectText =
  '{"$schema":{"$link":"sha256:cf76929b1ed8423c16a19e6dc435f82e007bcff00c2020c94abbb4ad73e97eb0"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4";
const rootText = '{"$schema":null,"language":"JSON Schema"}';
const rootLink = "sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326";
const schemeSchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"name":{"type":"string"},"publicKeyLength":{"minimum":1,"type":"integer"}},' +
  '"required":["name","publicKeyLength"],"title":"Key Scheme","type":"object"}}';
const schemeSchemaLink = "sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4";
const ed25519SchemeText =
  '{"$schema":{"$link":"sha256:14916fbf1e5472070cfde6c14cfdde45186db7ec6cc19d91f12bcad38e1357f4"},' +
  '"name":"ed25519","publicKeyLength":32}';
const ed25519SchemeLink = "sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528";
const identitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root","at"],' +
  '"title":"Identity","type":"object"}}';
const identitySchemaLink = "sha256:f9fcc71f3625929ed2d27067970e7d6cb38db30dd3d4d1c41d81be5b046f5ab7";
const keyText =
  '{"$schema":{"$link":"sha256:57236c4b4d4885a804a04068e9a8c5b0a5a25cf27b8b248c7671d1495b3f0528"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9";
const identityText =
  '{"$schema":{"$link":"sha256:f9fcc71f3625929ed2d27067970e7d6cb38db30dd3d4d1c41d81be5b046f5ab7"},' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:cfb93cd8b7d44611bdc136c3d6bb98c5204fa8e90d78d7fcc2233892b34405a9"}}';
const identityLink = "sha256:4f82dee355134c70145e97849da3f99017abac0240a21eb522e88a8329a8495b";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$",' +
  '"type":"string"},"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},"required":["identity","signature"],' +
  '"title":"Signed Identity","type":"object"}}';
const signedIdentitySchemaLink = "sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:4f82dee355134c70145e97849da3f99017abac0240a21eb522e88a8329a8495b"},' +
  '"signature":"93b5b886255a444aa89df3676e028e36c25f0f6d065e69ca83f66746c482af8bd3fcd7a9952afd7257b720a' +
  'ff4733761c142ad0d12307c808b71efce3e022a01"}';
const signedIdentityLink = "sha256:594e6783ce52b6d891186b15aed00844b84468b458ccba166dd15d77f537eadf";
const signatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"92af1ae34cf530cfc3f433ba227b42d69835955df17f3cb1174177b7078bd6beb7dcdc47c71dab2b342c0a2' +
  'c1b7924da6b49ac8cfecbcdec3b31c2a4a14d1c09",' +
  '"signedIdentity":{"$link":"sha256:594e6783ce52b6d891186b15aed00844b84468b458ccba166dd15d77f537eadf"}' +
  "}";
const signatureLink = "sha256:24f33da59eee939ccaaafb3c5ed731ebad91acc0bb6b9b9600c8b82db219cb2b";

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
