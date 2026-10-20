import { describe, expect, it } from "vitest";
import { publicKeyFrom, seal } from "../src/key.ts";
import { encodeMessage, MailboxKey } from "../src/index.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
const message = { entry: utf8("entry"), blobs: [utf8("blob")] };
const sealTo = async (key: MailboxKey, plaintext: Uint8Array) => seal(await publicKeyFrom(key.publicKey), plaintext);
const sealed = await sealTo(bob, encodeMessage(message));

describe("a mailbox key", () => {
  it("opens what was sealed to it, as many times as it arrives", async () => {
    expect(await bob.open(sealed)).toEqual(message);
    expect(await bob.open(sealed)).toEqual(message);
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

  it("refuses what opens but is not a message", async () => {
    await expect(bob.open(await sealTo(bob, utf8('{"entry":"ZQ"}')))).rejects.toThrow(/fields blobs and entry/);
  });

  it("is not made from a secret key of 31 bytes", async () => {
    await expect(MailboxKey.fromSecretKey(new Uint8Array(31))).rejects.toThrow();
  });
});
