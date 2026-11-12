import { linkOf, objectFormat, schemaOf } from "@estoc/object";
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
const noteLink = "sha256:304d61c68015b6b5428eb13b0de00bf42912d848daa898df848c366b9dcb7632";
const root = `da656f662182d9486c5820${noteLink.slice("sha256:".length)}a164746578746568656c6c6f`;
const rootLink = "sha256:a4dff6076b3e33a6f39bb4a1e57cdefe922d492c93d98f21ff0a66ad2bc86e77";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "e72a66535dd5e206d0c6d1cd3a7d7be07e3c505a431bf59063d0d68e47e1b3224a1c8e49a8e06fb54eb3417c087331a02f8dfe7ac5f53be3cd2c3fa47df6dd18" +
  "1c6ff28908e45addc6142adefda1f790772a83fd0b229b776439324b3bb3f1a71dc1e676e4a13b506ffbd5";

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
  expect(schemaOf(bundle.root, objectFormat)).toBe(noteLink);
  expect(schema("Note", { text: string() }).link).toBe(noteLink);
});
