import { encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { hex } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import { loadHttpTransport } from "../src/http.ts";
import { MailboxKey, mailboxSchema } from "../src/index.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, and
// its hashlib. The ciphertext was made by the HPKE of Python's
// cryptography package, with a random ephemeral key, for the secret key of
// 32 bytes of 1, over a zip that Python's zipfile wrote without compression;
// another info, KEM, KDF or AEAD does not open it. A change to the format
// changes them.
const schemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"name":{"type":"string"}},' +
  '"required":["key","name"],"title":"Memory mailbox","type":"object"}}';
const schemaLink = "sha256:3b4546b1f354600643aa3eb0cbfdb81cd2d401d91d719a09a0cbd7f39c5664f1";
const httpSchemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"url":{"format":"uri",' +
  '"pattern":"^(https://|http://(localhost|127\\\\.0\\\\.0\\\\.1|\\\\[::1\\\\])(:[0-9]+)?([/?#]|$))",' +
  '"type":"string"}},"required":["key","url"],"title":"HTTP mailbox","type":"object"}}';
const httpSchemaLink = "sha256:f13d679656670434f0ba582a6035de52b2caa98c9c055a0de0c5fb1ae9867792";
const publicKey = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
const rootText =
  '{"$schema":{"$link":"sha256:c9e93e6ce90a74281807c4b97bc57c64f6dc977528fcbe2d6c45b9035acb05f9"},' + '"text":"hello"}';
const rootLink = "sha256:ba723e2a7497a6919764e06fb1dc2303313d92abc3dfdae235e9fdfbfe084219";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const ciphertext =
  "d9f313c82335238230040bfbcfe96956cf8f7b0db47ea1422ef88cd735cd7324020e30a371ca503abfa0250fe1ad78ef6ef12a92fc7eac5ddcf5bb70311e94ab" +
  "60f9cdc14a1bf016e1d3493b11dc8db880a119572aa37f1a4468a92444069f0d7a6c553beb258708aa63369685509c49652923d5b453b04d65833535d4ea8dc1" +
  "f254e6ea3dc309e3a49960ecb205a1e0e2ab517ed787aff53e371319f989668359f8b50c9b38b9a82d441161474bfd370187578984259312e96416bf19cadb43" +
  "c859f5d83af060f73b0e03e41ef02dc9f653f8eb721f4188f19e62066f5651db6e2b71b6c39ab1811ec3023e6f5573147b3231c14c9099d5b5778c1417444129" +
  "4f8794040171b882817a7e0d577b8950ecf20f6bb08d387d1b05736c01839e5d394de71c20986662636ebd55c3ed4427931ec552783e8c4d94515b6951ca0c74" +
  "fe2c1d5e758f1d85deaef3c9ff25ebf7c72c6d89b828f0cdaf80262d4c1b97aaf6f555fd41b2a4706cc4ced67b0a3a6047aca86544469a9ce8e32d4b946aeeba" +
  "51026e4c4d8f110048990cc6b0995c3142d4f7db452156a2b3398ad32d44ba0d788e3bcf5819dbcccdc16a0587443491d5ad35aa359ee83315c1bf83f6f1d092" +
  "becfca001f9389ce356a977deb6f49461aada705df6db93f2b5d68d3e1995e87ae382f48ae97c1e5eb79ae2cb9142cf00a964de9603f5506389763e705";

const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

describe("the memory mailbox schema and an x25519 key", () => {
  it("encode to fixed bytes, a fixed link and a fixed public key", async () => {
    const schema = await encodeSchema(
      mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]),
      defaultValidator,
    );
    expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
    expect(schema.link).toBe(schemaLink);
    expect(hex.encode(key.publicKey)).toBe(publicKey);
  });
});

test("the HTTP mailbox schema encodes to fixed bytes and a fixed link", async () => {
  const { schema } = await loadHttpTransport(defaultValidator);
  expect(new TextDecoder().decode(schema.bytes)).toBe(httpSchemaText);
  expect(schema.link).toBe(httpSchemaLink);
});

test("a ciphertext made elsewhere opens with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(ciphertext));
  expect(new TextDecoder().decode(bundle.root)).toBe(rootText);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
});
