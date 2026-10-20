import { encodeSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { encodeMessage, MailboxKey, mailboxSchema } from "../src/index.ts";

// The bytes and the link were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, its
// base64 and its hashlib. The sealed bytes were made by the HPKE of Python's
// cryptography package, with a random ephemeral key, for the secret key of
// 32 bytes of 1; another info, KEM, KDF or AEAD does not open them. A change
// to the format changes them.
const messageText = '{"blobs":["-_-_",""],"entry":"ZW50cnk"}';
const schemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"key":{"pattern":"^[0-9a-f]{64}$","type":"string"},"name":{"type":"string"},' +
  '"until":{"format":"date-time","type":"string"}},"required":["key","name"],"title":"Memory mailbox","type":"object"}';
const schemaLink = "sha256:fc6cc266063d0a362713c1650dda5983960d2ade0f67b68bc03a6257346e545a";
const publicKey = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
const sealed =
  "2794510c04aa4b5319044e0c69dbe21a3afd125a89ece81af2bf8f183d83310c" +
  "e000646184468def9124e71d8bffddce73dae27787e58c8da47b27ea46b57387332199183b8f233dc3a95b4a9075a05078521f12e172b8";

const message = { entry: new TextEncoder().encode("entry"), blobs: [new Uint8Array([0xfb, 0xff, 0xbf]), new Uint8Array()] };
const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(1));

describe("a message of two blobs, the memory mailbox schema and an x25519 key", () => {
  it("encode to fixed bytes, a fixed link and a fixed public key", async () => {
    expect(new TextDecoder().decode(encodeMessage(message))).toBe(messageText);
    const schema = await encodeSchema(mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]), defaultValidator);
    expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
    expect(schema.link).toBe(schemaLink);
    expect(hex.encode(key.publicKey)).toBe(publicKey);
  });

  it("open sealed bytes made elsewhere to that message", async () => {
    expect(await key.open(hex.decode(sealed))).toEqual(message);
  });
});
