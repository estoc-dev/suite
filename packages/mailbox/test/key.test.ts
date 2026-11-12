import { encodeBundle } from "@estoc/bundle";
import { encodeObject, linkOf } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { MailboxKey } from "../src/index.ts";
import { publicKeyFrom, seal } from "../src/key.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
const note = schema("Note", { text: string() });
const root = encodeObject(note, { text: "hello" });
const blob = utf8("blob");
const sealTo = async (key: MailboxKey, plaintext: Uint8Array) => seal(await publicKeyFrom(key.publicKey), plaintext);
const ciphertext = await sealTo(bob, encodeBundle(root, [blob]));

describe("a mailbox key", () => {
  it("opens what was sealed to it to the bundle inside, as many times as it arrives", async () => {
    for (const bundle of [await bob.open(ciphertext), await bob.open(ciphertext)]) {
      expect(bundle.link).toBe(root.link);
      expect(bundle.get(linkOf(blob))).toEqual(blob);
    }
  });

  it("does not open what was sealed to another key", async () => {
    await expect(carol.open(ciphertext)).rejects.toThrow(/does not open with this key/);
  });

  it.each([
    ["the first byte of enc", 0],
    ["the last byte of enc", 31],
    ["the first byte of the ciphertext", 32],
    ["the last byte of the tag", ciphertext.length - 1],
  ])("does not open a ciphertext with %s changed", async (_, at) => {
    const changedCiphertext = ciphertext.map((byte, i) => (i === at ? byte ^ 1 : byte));
    await expect(bob.open(changedCiphertext)).rejects.toThrow(/does not open with this key/);
  });

  it.each([0, 31, 32 + 15])("does not open a ciphertext cut to %i bytes", async (length) => {
    await expect(bob.open(ciphertext.subarray(0, length))).rejects.toThrow(/does not open with this key/);
  });

  it("refuses what opens but is not a bundle", async () => {
    await expect(bob.open(await sealTo(bob, utf8('{"blobs":[],"entry":"ZQ"}')))).rejects.toThrow(/an object of est/);
    const withoutRoot = encodeBundle(root, [blob]).subarray(root.bytes.length);
    await expect(bob.open(await sealTo(bob, withoutRoot))).rejects.toThrow(/an object of est/);
    const cut = encodeBundle(root, [blob]).subarray(0, -1);
    await expect(bob.open(await sealTo(bob, cut))).rejects.toThrow();
  });

  it("tells whether a public key is its own", () => {
    expect(bob.hasPublicKey(bob.publicKey)).toBe(true);
    expect(bob.hasPublicKey(carol.publicKey)).toBe(false);
    expect(bob.hasPublicKey(bob.publicKey.subarray(0, 31))).toBe(false);
  });

  it("is not made from a secret key of 31 bytes", async () => {
    await expect(MailboxKey.fromSecretKey(new Uint8Array(31))).rejects.toThrow();
  });
});
