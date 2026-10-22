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
const rootText = '{"data":"hello","schema":{"$link":"sha256:612c3c87bf6797405b741d516ad1866d9395ec1d20276a5baf58fc676aabff2f"}}';
const rootLink = "sha256:7bc449748d17dc99b26bfe2eb88b2702d90ebe868c9507fcc3735cb4b40191a8";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const sealed =
  "53bb72f91616293f93cd4bb8560471885ea3eb190aa0634220ad5aa747c3c901a76962788bd07fa65589a25df43d38749bd17ab53a37e881acbf079c673b817c" +
  "ddcd998814ac5dbc08660872dca871267269aa590af3ce4eaf9c7e957a08189beb730a86b43925fbacc645f43404ccf24d810c148dd3524cdc52e7880146eb77" +
  "6811f8a8db0e7aa52466deb49d28b1eb96fd93b6f5b3e89f3675a426e4d14d0a6768ddf95a59953db1b68f34e32170ac10eb2dd3af9ee86046f20635c25dd04f" +
  "294064fba70bfdd867306e9c2aa278bd25086585a6af28c19df2475cbad4c6d6e481969b4d245891a46657f53b781811f7f92e3f0f01338482f0738242d37d54" +
  "6a20b063eba8812487f9c7b86728dae8cbb612ff4de83ce5fceb07192ee65281fa4f35ca550f3922fb630922df6a21dfc967df47f4200bb4ae2dab0f5940a12c" +
  "55136202feef3c0527e4f9295c1b6d4fde157f9169dd45d7570d782099c97bee39d5c87a0316e52fb123b74810d6fc4b237ec45c9bd85b63d7c25e75bf7dbd1a" +
  "568f9afe96322b6ab71dd4161c60090cf28f2d9148e1a80783efdfdbe7e2a1618b8f301538e3a4eafee1b6c6fee615c74cce83c733398779d521c053edc06de3" +
  "e782c6df7b4b45f28557bea3ff7b070e3183bbf38ec4403c8d03ccce13febdc8462f13b192466f5fd7f303875fa0c02fab956059cc92876539233bd0";

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
