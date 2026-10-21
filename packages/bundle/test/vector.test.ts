import { readFileSync } from "node:fs";
import { encodeObject, encodeSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, unzipBundle, writeBundle } from "../src/index.ts";

// The envelope's schema and the root were checked against Python's json
// module with sorted keys and no whitespace, which writes these values as JCS
// does, and its hashlib. The login object and the signature over it are the
// vector of @estoc/object. A change to the format changes them.
// stored-by-python.zip holds the same files as Python's zipfile writes them,
// without compression and with index.json last.
const envelopeText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"signature":{"$ref":"https://estoc.dev/schema/link"}},"required":["signature"],"title":"Signed","type":"object"}';
const envelopeLink = "sha256:79ac5f8f724b527bd6d3831ae0fe3c0e5ddb491ad861a3c79d9fccad4bfb1331";
const rootText =
  '{"data":{"signature":"sha256:8d74a99c3920cb6cf4c14447be35110a091aea6a00a9cf0773265e515bdc796b"},' +
  '"schema":"sha256:79ac5f8f724b527bd6d3831ae0fe3c0e5ddb491ad861a3c79d9fccad4bfb1331"}';
const rootLink = "sha256:8ce1fe21e00c43f8247ae733938b6a40ee686eb3e89383b690cd0e4ad67b6699";
const objectText =
  '{"data":{"audience":"https://app.estoc.dev","nonce":"6f1c0a9e"},' +
  '"schema":"sha256:ed3c6fdbbb01a4093bf529293bc6e65f3d56d00f5729fdde619ea9fb1a8ec90e"}';
const objectLink = "sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80";
const signatureText =
  '{"identity":{"publicKey":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","scheme":"ed25519"},' +
  '"object":"sha256:65a66b9ddb1b8afe6fdc7d0c4ebef359b9c9657ce6712b82d1ba583dc159fb80",' +
  '"signature":"597af40ffd741eaf60009f405797ac722591b9f2f63966055722a409412bd00d' +
  '0ecfa9ae9d9c0e158301fe20a0b6aefdf25a6078117e4d524493212271b12608"}';
const signatureLink = "sha256:8d74a99c3920cb6cf4c14447be35110a091aea6a00a9cf0773265e515bdc796b";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
const files = new Map([
  ["index.json", rootText],
  [`blobs/sha256/${signatureLink.slice(7)}`, signatureText],
  [`blobs/sha256/${objectLink.slice(7)}`, objectText],
]);

const envelope = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Signed",
    type: "object",
    properties: { signature: { $ref: "https://estoc.dev/schema/link" } },
    required: ["signature"],
    additionalProperties: false,
  },
  defaultValidator,
);

describe("a bundle whose root refers to a signature over a login object, carrying the signature and the object", () => {
  it("writes to fixed files", () => {
    expect(text(envelope.bytes)).toBe(envelopeText);
    expect(envelope.link).toBe(envelopeLink);
    const root = encodeObject(envelope, { signature: signatureLink });
    const written = writeBundle(root, [utf8(signatureText), utf8(objectText)]);
    expect(new Map([...written].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
  });

  it("reads from those files with the root's link, and gets each blob by its link", () => {
    const bundle = readBundle(new Map([...files].map(([path, text]) => [path, utf8(text)])));
    expect(text(bundle.root)).toBe(rootText);
    expect(bundle.link).toBe(rootLink);
    expect(text(bundle.get(rootLink))).toBe(rootText);
    expect(text(bundle.get(signatureLink))).toBe(signatureText);
    expect(text(bundle.get(objectLink))).toBe(objectText);
  });

  it("unzips to those files from a zip that another tool made", async () => {
    const zip = new Uint8Array(readFileSync(new URL("stored-by-python.zip", import.meta.url)));
    const unzipped = await unzipBundle(zip);
    expect(new Map([...unzipped].map(([path, bytes]) => [path, text(bytes)]))).toEqual(files);
    expect(readBundle(unzipped).link).toBe(rootLink);
  });
});
