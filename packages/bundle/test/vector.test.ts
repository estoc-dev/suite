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
  '{"$schema":{"$link":"sha256:cf76929b1ed8423c16a19e6dc435f82e007bcff00c2020c94abbb4ad73e97eb0"},' +
  '"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"}';
const objectLink = "sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4";
const rootText = '{"$schema":null,"language":"JSON Schema"}';
const rootLink = "sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326";
const keyInterfaceLink = "sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160";
const identityInterfaceLink = "sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f";
const keySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"publicKey":{"pattern":"^[0-9a-f]{64}$","type":"string"}},"required":["publicKey"],' +
  '"title":"Ed25519 key","type":"object",' +
  '"x-implements":{"$link":"sha256:99a52df3ff3d499488e2fa28150c4106a2cb5e928891a830a9aa3922b2d32160"}}}';
const keySchemaLink = "sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d";
const identitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"root":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["root","at"],' +
  '"title":"Identity","type":"object",' +
  '"x-implements":{"$link":"sha256:999f23fcd7bec7075e54bb5dea0d9c548bfe7261f95b911ed8e23d2f4188724f"}}}';
const identitySchemaLink = "sha256:22ad1b36ad3b46ada728ea6d6df738a1f306bf6917cef82d7c7a951709e1b422";
const keyText =
  '{"$schema":{"$link":"sha256:806f6c529a168ad41bc7deee10a1c67027f2332648fa29a7a5f33bff9d83f19d"},' +
  '"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}';
const keyLink = "sha256:5c8f964122280caf757367dee41bbfa6fd25be5fd70280ce2949ecbad76efa01";
const identityText =
  '{"$schema":{"$link":"sha256:22ad1b36ad3b46ada728ea6d6df738a1f306bf6917cef82d7c7a951709e1b422"},' +
  '"at":1767225600000,' +
  '"root":{"$link":"sha256:5c8f964122280caf757367dee41bbfa6fd25be5fd70280ce2949ecbad76efa01"}}';
const identityLink = "sha256:fbabefdf1d2020bd7c8da5ad3fddb1a9eb408ed1fe1b374a45f10ddb46257c96";
const signedIdentitySchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"identity":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"signature":{"pattern":"^(?:[0-9a-f]{2})*$","type":"string"}},"required":["identity","signature"],' +
  '"title":"Signed Identity","type":"object"}}';
const signedIdentitySchemaLink = "sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2";
const signedIdentityText =
  '{"$schema":{"$link":"sha256:6ff4089d10d54822ae943cd0d5d6c2122382d269c79e59306c2ea7a3c1db8ec2"},' +
  '"identity":{"$link":"sha256:fbabefdf1d2020bd7c8da5ad3fddb1a9eb408ed1fe1b374a45f10ddb46257c96"},' +
  '"signature":"ca32524b421edba33e57e0f39be585a9d243fde02ef4662a616b880e48fd3ffb1499997e490aadf276dfdf0d284' +
  '97ab9061db5fad80635dfb335650c0a29f30d"}';
const signedIdentityLink = "sha256:db798bd9d9c764128778606fc3e0529f4104e3a2f37894512c4d7d73290ec4f5";
const signatureText =
  '{"$schema":{"$link":"sha256:7090ce0b5950e2d59e4af998b51090059cff783b8f05b4c12817acbe36c573c4"},' +
  '"object":{"$link":"sha256:7f0842ff8211ee8330f12285571af67d615bb76dbedaec6eb9b5ae9686fa2df4"},' +
  '"signature":"16ee674e6a0d4bfcea87e6a04bacba19b43d67e6e89501dd36e322ab5c2db74decf00cb9ddb82f4152e10033815' +
  '111447f479ee08896ae6900e5a2d038882e0e",' +
  '"signedIdentity":{"$link":"sha256:db798bd9d9c764128778606fc3e0529f4104e3a2f37894512c4d7d73290ec4f5"}}';
const signatureLink = "sha256:d5dcd6b8364fdabfb2ae49a92f0bfc2c84ca6da05748d606135fe440ae92278e";

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
