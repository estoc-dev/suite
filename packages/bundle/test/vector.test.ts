import { readFileSync } from "node:fs";
import { loadSignatures } from "@estoc/identity";
import { decodeObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);

// The login object is the vector of @estoc/object, and the signature over it
// and its signer's signed identity, with the signed identity's blobs, those
// of @estoc/identity. A change to the format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const objectText =
  '{"$describedBy":{"$link":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c";
const keyInterfaceLink = "sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160";
const identityInterfaceLink = "sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f";
const keySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
  '"required":["publicKey"],"title":"Ed25519 key","type":"object",' +
  '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}';
const keySchemaLink = "sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662";
const keyIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root"],"title":"Key Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}';
const keyIdentitySchemaLink = "sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362";
const keyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358";
const identityText =
  '{"$describedBy":{"$link":"sha256:bffc12f8ae0d1515e678ceca43c4d2a1b05ce53ee822500fd30c868d0210f362"},' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const identityLink = "sha256:e36a63b250c8e05258d06aa68b0b1ead71b255ad08a96f426c9ee52ef6e34b99";
const signedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","signature"],"title":"Signed Identity","type":"object"}';
const signedIdentitySchemaLink = "sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa";
const signedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:e36a63b250c8e05258d06aa68b0b1ead71b255ad08a96f426c9ee52ef6e34b99"},' +
  '"signature":"879c083c555339acf377ad210b00c9ea74740e6f197e696baf5f128506eb0927' +
  '4276759c728e131a40270acd15491537fa50f0818301b49c4759f3ba72514c03"}';
const signedIdentityLink = "sha256:85dd9e2207b1a986cde3784d467879bd7d9ce952d70c37acce9dce617a4576d2";
const signatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"6c029e975d7ae1f996fe751a8f0df35c068603921b63067ba9e66ddb18f08545' +
  'b36d69a64229c7ec4b0bb2ee45c44e7d79dca56de14b02d2076e318e70cd150e",' +
  '"signedIdentity":{"$link":"sha256:85dd9e2207b1a986cde3784d467879bd7d9ce952d70c37acce9dce617a4576d2"}}';
const signatureLink = "sha256:b836107915964928489dc710ded994b19f7aff1ac3fcae4ee22eb6e9529b09f3";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const blobs = new Map<Link<unknown>, string>([
  [objectLink, objectText],
  [signedIdentityLink, signedIdentityText],
  [signedIdentitySchemaLink, signedIdentitySchemaText],
  [identityLink, identityText],
  [keyLink, keyText],
  [keyIdentitySchemaLink, keyIdentitySchemaText],
  [keySchemaLink, keySchemaText],
  [identityInterfaceLink, "Identity"],
  [keyInterfaceLink, "Key"],
]);
const files = new Map([
  ["index.json", signatureText],
  ...[...blobs].map(([link, text]) => [`blobs/sha256/${link.slice(7)}`, text] as const),
]);

describe("a bundle whose root is a signature over a login object, carrying the object and the signer's signed identity", () => {
  it("writes to fixed files", async () => {
    const read = decodeObject(utf8(signatureText), signatures.schema);
    const signature = await signatures.verify(
      read,
      new Map([
        [signedIdentityLink, utf8(signedIdentityText)],
        [identityLink, utf8(identityText)],
        [keyLink, utf8(keyText)],
      ]),
    );
    const written = writeBundle(signature, [utf8(objectText), ...signature.signedIdentity.blobs]);
    expect(new Map([...written].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
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
    const unzipped = await unzipBundle(zip);
    expect(new Map([...unzipped].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
    expect(readBundle(unzipped).link).toBe(signatureLink);
  });
});
