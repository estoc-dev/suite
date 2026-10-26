import { writeBundle, zipBundle } from "@estoc/bundle";
import { encodeObject, encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MailboxKey } from "../src/index.ts";
import { publicKeyFrom, seal } from "../src/key.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const root = encodeObject(note, { text: "hello" });
const blob = utf8("blob");
const sealTo = async (key: MailboxKey, plaintext: Uint8Array) => seal(await publicKeyFrom(key.publicKey), plaintext);
const sealed = await sealTo(bob, await zipBundle(writeBundle(root, [blob]), { compress: false }));

describe("a mailbox key", () => {
  it("opens what was sealed to it to the bundle inside, as many times as it arrives", async () => {
    for (const bundle of [await bob.open(sealed), await bob.open(sealed)]) {
      expect(bundle.link).toBe(root.link);
      expect(bundle.get(linkOf(blob))).toEqual(blob);
    }
  });

  it("does not open what was sealed to another key", async () => {
    await expect(carol.open(sealed)).rejects.toThrow(/do not open with this key/);
  });

  it.each([
    ["the first byte of enc", 0],
    ["the last byte of enc", 31],
    ["the first byte of the ciphertext", 32],
    ["the last byte of the tag", sealed.length - 1],
  ])("does not open sealed bytes with %s changed", async (_, at) => {
    const changed = sealed.slice();
    changed[at]! ^= 1;
    await expect(bob.open(changed)).rejects.toThrow(/do not open with this key/);
  });

  it.each([0, 31, 32 + 15])("does not open sealed bytes cut to %i bytes", async (length) => {
    await expect(bob.open(sealed.subarray(0, length))).rejects.toThrow(/do not open with this key/);
  });

  it("refuses what opens but is not the zip of a bundle", async () => {
    await expect(bob.open(await sealTo(bob, utf8('{"blobs":[],"entry":"ZQ"}')))).rejects.toThrow();
    const withoutRoot = new Map([...writeBundle(root, [blob])].filter(([path]) => path !== "index.json"));
    await expect(bob.open(await sealTo(bob, await zipBundle(withoutRoot, { compress: false })))).rejects.toThrow(
      /index.json/,
    );
  });

  it("refuses a zip whose files come to more bytes than the zip, as only a compressed one can", async () => {
    const compressed = await zipBundle(writeBundle(root, [new Uint8Array(2 ** 16)]));
    await expect(bob.open(await sealTo(bob, compressed))).rejects.toThrow(/more than/);
  });

  it("is not made from a secret key of 31 bytes", async () => {
    await expect(MailboxKey.fromSecretKey(new Uint8Array(31))).rejects.toThrow();
  });
});
