import { encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { hex } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import { loadHttpTransport } from "../src/http.ts";
import { MailboxKey, mailboxSchema } from "../src/index.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, and
// its hashlib. The sealed bytes were made by the HPKE of Python's
// cryptography package, with a random ephemeral key, for the secret key of
// 32 bytes of 1, over a zip that Python's zipfile wrote without compression;
// another info, KEM, KDF or AEAD does not open them. A change to the format
// changes them.
const schemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"name":{"type":"string"}},' +
  '"required":["key","name"],"title":"Memory mailbox","type":"object"}';
const schemaLink = "sha256:ad78ace09f4e1f8597af52bc27c63f478b632545742521797d694a13ddba4f9e";
const httpSchemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},' +
  '"url":{"format":"uri","pattern":"^(https://|http://(localhost|127\\\\.0\\\\.0\\\\.1|\\\\[::1\\\\])(:[0-9]+)?([/?#]|$))",' +
  '"type":"string"}},' +
  '"required":["key","url"],"title":"HTTP mailbox","type":"object"}';
const httpSchemaLink = "sha256:8ffecf613658fc3f846c3a40be80feec587ce034ad53edd769708f3078ac1e4c";
const publicKey = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
const rootText = '{"data":"hello","schema":"sha256:612c3c87bf6797405b741d516ad1866d9395ec1d20276a5baf58fc676aabff2f"}';
const rootLink = "sha256:9728eff8389d5e355f4b2576ee1b66523d8ed7d3b7cdab5542be3ca401767a18";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const sealed =
  "8c5ec6700c74907633818382d04387591c854595c863ae646aa9a6a0eb9955656228d26c9d51f7a82ab4dc178d52b025ef89c0818b9c69c9d0321612b48618d4" +
  "1613d50498be87ffaa44271827114bd1f88d1ef4cf53ed44b90e9b7b34ce6c0d75b6e3b56adc7c83a1d34c3dd58433c89e87456628afdfcaecda73223f53f7be" +
  "eb012cf165adef54e93cf3c66b243e551ac3a3938351e7ee445f7443e9d22196b95b8c3ffadf502ab5b184e84b01d398797239f19f9a9d2aa812dc6b5b0effad" +
  "29201e716e40eb774f172db9352e85234f929e1b63d171e0faf348a4297ee197427e538a31f15002e5c16d291852b3e8e11cc20de792e8ccc4496c0ede254a4b" +
  "20a64eb18a54b900686482d06a5cefcc203bdc4a3fd222035df4d64a436f637a02ce9eeb43d03050c057628721e41affbc781aa1ec142779722b8de6e4c97a8a" +
  "b8029e74b26ca42fc735e31a20c79a9a8b213ab348741bb136958e3dc26972bad66025a609cf2c3044d1905c8856b7ea321d823eff4ae616eb46910f730768e5" +
  "fd7ecfcca00fbd659374db571668d361b3b5dd6a6796beae2275f4633c2d90f27ae54e235d1e9d2a46ba2bea9a1db68944a801c7162aed27af13fa99c0639177" +
  "5f5586825cb883ee35614c5c1c10b4f24c1847e026c7834cf25af38c9e1c59b9ed0c3537c05667724bd3fc41c7d6bf84753b";

const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

describe("the memory mailbox schema and an x25519 key", () => {
  it("encode to fixed bytes, a fixed link and a fixed public key", async () => {
    const schema = await encodeSchema(mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]), defaultValidator);
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

test("sealed bytes made elsewhere open with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(sealed));
  expect(new TextDecoder().decode(bundle.root)).toBe(rootText);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
});
