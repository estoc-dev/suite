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
const rootText =
  '{"$describedBy":{"$link":"sha256:c9e93e6ce90a74281807c4b97bc57c64f6dc977528fcbe2d6c45b9035acb05f9"},' +
  '"text":"hello"}';
const rootLink = "sha256:dd1214fe04959de3cb3525458a5f3efe22bff32286d6eb29dc5d08db784422b2";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const sealed =
  "f1e327bbd565e5553480d482b7b2f0b6d0e0049899f95bb99db1e0cf06b9281660d31a37d01d7ed22e58fd8a0f2381be4abd1e80f71a53b9debc44b58db07b57" +
  "706f727b8c5762c4242fc6fbf18b5fcb5a0203633b4af826237fcaef952bcbf250143ca6aee3f13116d3eef9bb08540463308aa62ce76a9b9471a49845dd1f30" +
  "0d883ed7de51a5c000b906ca7e6017e665ae06b7ec3ebba0001acf650878d807d98e170707ebd7f980fed094d68639125e91def7d375a6ae694a58f96995e8e7" +
  "3cfc8fa5109d8e8beeaf7a68e1f542c9282b9d98c261bc3fa0f4fc1b2df96b66ed561a667a8d29a384a401384ec8605d787db4b89965ebf21b95fa8c69521b3e" +
  "7aa470d3f0b850cdae783097108e6fe401c73be434927242f58d19e46eb9c1f6238050401d402c789316b6a6d0ab2d4fbc09e2befc95db54bc63a445e785f191" +
  "967107764b84e45ad937a05548905d10c945d4f10e91bfdf5528b0e394e60a0bf6d1b1543431ad6801346df6a899f986815f10b866d8107b26f0470ccd3f7b3b" +
  "84af7cd05c6d660dde6e732c2dbf731fab5557e6b9f831cda77840fa771882d84bdb32b2a1b5c99278b044116b33e4e4af3976e874993e10be989c288e5c031e" +
  "2e2944df50d4273af6aecf21513118f5c4563aeae8135f342c193761dd3c03a20e6f94b7a4828a7cd7b16275de07e6ed6ff8c786d9a963c446c24d33bb770c7f" +
  "3b7b";

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

test("sealed bytes made elsewhere open with that key to a bundle of a root and a blob", async () => {
  const bundle = await key.open(hex.decode(sealed));
  expect(new TextDecoder().decode(bundle.root)).toBe(rootText);
  expect(bundle.link).toBe(rootLink);
  expect(bundle.get(linkOf(blob))).toEqual(blob);
});
