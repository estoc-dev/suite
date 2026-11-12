import { est, linkOf, schemaOf } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { hex } from "@scure/base";
import { expect, test } from "vitest";
import { MailboxKey } from "../src/index.ts";

// The ciphertext was made by the HPKE of Python's cryptography package, with
// a random ephemeral key, for the secret key of 32 bytes of 1, over a bundle
// in one file whose CBOR was written out by hand in Python; another info, KEM,
// KDF or AEAD does not open it. The root is written to the schema of a note,
// whose bytes and those of its root schema were written the same way, and the
// links were checked against Python's hashlib.
const noteLink = "sha256:72e1185b089bff27d532382d74c6722631eddbf6785f56b76a2c3b87b85cfca2";
const root = `da6573743f82d9486c5820${noteLink.slice("sha256:".length)}a164746578746568656c6c6f`;
const rootLink = "sha256:50513b27ba0ecae5395f5ed741ebcc843b97bc49617d7d354716d25e250f5fdb";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "f0fbfb68a47462ef3c9392abbc005f3c6f746c182468c5d993c7c6610a870a370d1aa807c93da6735fc329cfafca57732e0edf3eae500742ccabee92c7d8ae30" +
  "d0901e009366c61b5e88c7d7691e433de2d609a5c3e6ccedf38b2d67e34b031712153dfcc6948cb7ebe1e0";

const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

test("a ciphertext made elsewhere opens with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(ciphertext));
  expect(hex.encode(bundle.root)).toBe(root);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
  expect([...bundle.blobs()]).toEqual([bundle.root, blob]);
});

test("the root of that bundle is written to the schema of a note as this suite writes it", async () => {
  const bundle = await key.open(hex.decode(ciphertext));
  expect(schemaOf(bundle.root, est)).toBe(noteLink);
  expect(schema("Note", { text: string() }).link).toBe(noteLink);
});
