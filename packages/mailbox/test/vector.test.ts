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
const rootText = '{"$type":{"$link":"sha256:c9e93e6ce90a74281807c4b97bc57c64f6dc977528fcbe2d6c45b9035acb05f9"},' + '"text":"hello"}';
const rootLink = "sha256:924c53891d3a9ef8f03dbfdee0264e0b072994701ef9c9b72c82e4f7b2d2080f";
const blob = new Uint8Array([0xfb, 0xff, 0xbf]);
const sealed =
  "0f2e4ab630d257f7d68ba3a84308ab1bb28b5beff20d0742d01843e47bf5d677aea295e6bf576a28384dd862b390c93e59214608d569a3450f005f3dd4f8eb00" +
  "de63c2a916539941f3736460ea352494b4874199637542be91f0cfe0508f90b26ad8d29637ffc95ffbd4b73a4442f9ed6e0b54d34ee1d7b099c55d91700e082d" +
  "4f5feef51c90d6403607fe3f250ef8b9e2883790ebb5492e8d2a30fdd19e22d20cfaff3335a57d4f567372105e7998ce8fe73ebc9ca8403bfafb61921e4b3bf8" +
  "a4bda27a26964630c5ccfc4bba07c99b91e6ec7c0dc98a94ed1fd2cd81c5bc40b41e000da1743b5293b20f21c23c55ef4ee193a03d6e6e1557bf87ba3b9fa93f" +
  "ff7a18da662bcfe0440663d41e67482a5c7023a634726f6c52908ed5161e734cfa63b0552c229484ac515a27e0540cbd073e1ac9b84fe95e0a2510a4e8f36b81" +
  "cb9505af21f2de2004abfc34d1d55775de9276c605db73bb9278c29aa73bafb3f3d2ae85ce6028fd98e6019de2d33fb99d2072dd2a9c3f9772c4532aa1a8d635" +
  "0fd7bffbbb60228fee1d2db0a21a7d6234318860ad2ec876e8764e2bd721f73dfd902db49f048a747ce26634e327e7c62dd8ebd0f5a9ea80a946a47337e87f0d" +
  "1de0b7cb2eac508351644312a54c3675f286c9a3c0ec291bf1f7672a5f2b26a36ef568907afc0d446f4473e43f19ac01731e8b30cd8fe7e6b166db";

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
