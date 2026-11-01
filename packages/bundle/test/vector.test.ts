import { readFileSync } from "node:fs";
import { loadIdentity, noVersions } from "@estoc/identity";
import { decodeObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

const { signatures } = await loadIdentity(defaultValidator);

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
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root","at"],"title":"Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}';
const identitySchemaLink = "sha256:2925548520e954bb82d94214d2b85a334b851966ec0603dd1537ec1811221194";
const keyText =
  '{"$describedBy":{"$link":"sha256:ebbcea47c3c3ce9adc3d76f8450ceba8f413d247a4b2f9b30aca6d2505beb662"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358";
const identityText =
  '{"$describedBy":{"$link":"sha256:2925548520e954bb82d94214d2b85a334b851966ec0603dd1537ec1811221194"},' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:ecc75ffb48855e212f07f6a1bfe71da1e95e47d8f159a0354438ca6fefb90358"}}';
const identityLink = "sha256:9765b6f9fd07cb8028dc55244b82652e39bb55d69d8353c3e413fa4b9ed905cb";
const signedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","signature"],"title":"Signed Identity","type":"object"}';
const signedIdentitySchemaLink = "sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa";
const signedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:9765b6f9fd07cb8028dc55244b82652e39bb55d69d8353c3e413fa4b9ed905cb"},' +
  '"signature":"aaaf553e3f7ba3f235107155d0bd14eb59c0c8df74300e305a10d9a0fc59e1c5' +
  'a12b081cb298e10eb9e3405e4a80e647f974c04df9a63b7cf831de272a954101"}';
const signedIdentityLink = "sha256:d0a756f4ee31b20a78995e7d47d4899906c7ba7b15947a3e35664fdadffb7f13";
const signatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"59d738d7f8c5c7ef617acde85109c583580757cb049bf400036c5c1f73c0e34c' +
  'dc9bd536b9bdf97de1106db12f8e9a7f81cc4617fc74f7fd1b12a512421aad01",' +
  '"signedIdentity":{"$link":"sha256:d0a756f4ee31b20a78995e7d47d4899906c7ba7b15947a3e35664fdadffb7f13"}}';
const signatureLink = "sha256:6223032687970d05dd72660c90cca223d0dbcc3e87da3532bafff0abb79978fb";

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
      noVersions,
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
