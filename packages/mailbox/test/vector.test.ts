import { linkOf, schemaOf } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { hex } from "@scure/base";
import { expect, test } from "vitest";
import { MailboxKey } from "../src/index.ts";

// The ciphertext was made by the HPKE of Python's cryptography package, with
// a random ephemeral key, for the secret key of 32 bytes of 1, over the file
// of a bundle, whose CBOR was written out by hand in Python; another info,
// KEM, KDF or AEAD does not open it. The root is written to the schema of a
// note, whose bytes and those of its root schema were written the same way,
// and the links were checked against Python's hashlib.
const noteLink = "sha256:90efcb1ea7df1a7472978dadfe968d51eccfca2ba23b09f4f71a8650aadd906f";
const root = `da656f663f82d9486c5820${noteLink.slice("sha256:".length)}a164746578746568656c6c6f`;
const rootLink = "sha256:ad3418aebeca30a35d5813e55d56efc72556f6373cbae60df25061af877393bd";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "e9ca4071bb209099a4de7ebbda8a57068abfa2d4c1821d7891e0de5b027a372b7d1af6c864a925d3dd5a50ee290f5cba6053e6cffdc12396b33c1e61c617d690" +
  "d85984095410d002537d8ad78d09ab06a79c0aec2f310817b980d35fb8bc952652c5e1d2f6f86cc30a1b44";

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
  expect(schemaOf(bundle.root)).toBe(noteLink);
  expect(schema("Note", { text: string() }).link).toBe(noteLink);
});
