import { linkOf } from "@estoc/object";
import { hex } from "@scure/base";
import { expect, test } from "vitest";
import { MailboxKey } from "../src/index.ts";

// The ciphertext was made by the HPKE of Python's cryptography package, with
// a random ephemeral key, for the secret key of 32 bytes of 1, over a zip that
// Python's zipfile wrote without compression; another info, KEM, KDF or AEAD
// does not open it. The link of the root was checked against its hashlib.
const rootText =
  '{"$schema":{"$link":"sha256:44fc8ce7681ba2f2cea0ec126bf64ead0c1636e020f0c24135a64f7cf34fc388"},' + '"text":"hello"}';
const rootLink = "sha256:74a5df9bab3fa9dc432f20ac8095c5e417285215a354420e452fc682763d9949";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "5e025e3180cf29e4a9a55d78c18bee231a12a7745165c2db380b19e6cb5c18569f8b359a6da0fac2e3dcc23b284f73d0491050ba28dfe0ccaf29f6bc3b69e397" +
  "6920c299662d463fdca4657751673d810b8a9fb445fe7caf24ca1ecf64524cdcf0dabbcd6016ae1f431cf73ea666067c0fe4d30f30c880603e117c4360daeec7" +
  "0de45074510a58e7c6e8896ab2bc35ba88033957e022d2fce6826e9dd6b1cceff8d4cb6b010ccb7ea2541df62b3cb0635c39b689b99788c16be26d7ae1cd633d" +
  "c8295962ceeceaaa54eebf5e228d640afb3eb03647c0c2b7d6e167b19a4b8f543a32efa2d908cf66c07012b0df8a61030b62727f10a250a0504137161951b4af" +
  "e83518e69909768041b44135e481aade351c906fb14d513303110c8b8dfc5e24c3bba8261939d6269fa026f3e4a8e4cc4c07e712a793275f5f654d19f16ae39f" +
  "191c1c870081526e66bfa8bf17f5a07cdb22376899810ebb5ecc210c4175034641760ff95c4112bc6ebb71d48241f7243e4f8e030ee64e76bfed272f0889f5f7" +
  "2e60c922ef33d4dc7f30de7efe5718275c1d8e3947d9a519325b46e12c0c6c41435b7924ab8309ab66fc0ef009ab93691bf34832327674544abdf44d3f598b84" +
  "e76c920a369c3905dfc0497078bd6a79a52fb9e0ecb63a9a3845b2e5846ec63fcbe14a1cf3baef4528f5d40204a0acce48a2563ce769f1aad0c6476bec";

const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

test("a ciphertext made elsewhere opens with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(ciphertext));
  expect(new TextDecoder().decode(bundle.root)).toBe(rootText);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
});
