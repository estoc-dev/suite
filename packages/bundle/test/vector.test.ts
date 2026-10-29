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
const keySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},' +
  '"required":["publicKey"],"title":"Ed25519 key","type":"object"}';
const keySchemaLink = "sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a";
const identitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},' +
  '"required":["root"],"title":"Identity","type":"object"}';
const identitySchemaLink = "sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526";
const keyText =
  '{"$describedBy":{"$link":"sha256:56ba2935043425c303dcf4d2b68ad608ab724b342a8a4c78665829549917912a"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22";
const identityText =
  '{"$describedBy":{"$link":"sha256:5d77ddabc0855936a22068491f9a0d14ac6a32146334371283edb284a336a526"},' +
  '"root":{"$link":"sha256:a6394ae7524f9c1ba37d4a86bdc80de04e38d98e0308df12a51a932763e64b22"}}';
const identityLink = "sha256:dd31cd36c973940ddcfe6e5a688cf5d33b887b2693d82bae6b9fd359cabda364";
const signedIdentitySchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},' +
  '"required":["identity","signature"],"title":"Signed Identity","type":"object"}';
const signedIdentitySchemaLink = "sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa";
const signedIdentityText =
  '{"$describedBy":{"$link":"sha256:ee9e79ae29ac47b734cd73993d28f50b5bd4323c4693a304366958d3c6161dfa"},' +
  '"identity":{"$link":"sha256:dd31cd36c973940ddcfe6e5a688cf5d33b887b2693d82bae6b9fd359cabda364"},' +
  '"signature":"5cfaf21fdc8c442905a85577e8346727cd635d5042bbe45331b861c3444aef6e' +
  'aa149e6de2bf1543316e69bee4cf66c80056a3f25cb315cc621ae439d8386f01"}';
const signedIdentityLink = "sha256:3499b42ad3b10174ceac2b6d308326e7fb2f0678782c579595d7083a3b3beefe";
const signatureText =
  '{"$describedBy":{"$link":"sha256:5b26f24cc52953b3f9ed306e7773dcff9edc5cad8c6a825f02179e3a4a3d7135"},' +
  '"object":{"$link":"sha256:30b98860979cfbb8aff2e2d4b4cbffb449d618e7168ec3772d2757334c3def3c"},' +
  '"signature":"6c029e975d7ae1f996fe751a8f0df35c068603921b63067ba9e66ddb18f08545' +
  'b36d69a64229c7ec4b0bb2ee45c44e7d79dca56de14b02d2076e318e70cd150e",' +
  '"signedIdentity":{"$link":"sha256:3499b42ad3b10174ceac2b6d308326e7fb2f0678782c579595d7083a3b3beefe"}}';
const signatureLink = "sha256:5f7b0b3af90bb61a512241aaa46f65ca66349791272d91a3aff23a8e4c849f9b";

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
