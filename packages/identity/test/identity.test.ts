import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { Identity } from "../src/index.ts";

const ed25519Key = hexToBytes("79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664");
const secp256k1Key = hexToBytes("038318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75");

describe("Identity.from", () => {
  it("takes a 32-byte Ed25519 key for ed25519 and solana-offchain", () => {
    expect(Identity.from("ed25519", ed25519Key).scheme).toBe("ed25519");
    expect(Identity.from("solana-offchain", ed25519Key).scheme).toBe("solana-offchain");
  });

  it("takes a 33-byte compressed secp256k1 key for eip191", () => {
    expect(Identity.from("eip191", secp256k1Key).publicKey).toEqual(secp256k1Key);
  });

  it("refuses a key of the length another scheme uses", () => {
    expect(() => Identity.from("ed25519", secp256k1Key)).toThrow(TypeError);
    expect(() => Identity.from("eip191", ed25519Key)).toThrow(TypeError);
  });

  it("refuses an uncompressed secp256k1 key", () => {
    const uncompressed = hexToBytes(
      "048318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75" +
        "3547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5",
    );
    expect(() => Identity.from("eip191", uncompressed)).toThrow(TypeError);
  });

  it("refuses bytes that are not a point on the curve", () => {
    expect(() => Identity.from("eip191", Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xff)))).toThrow(
      TypeError,
    );
    expect(() => Identity.from("ed25519", Uint8Array.of(2, ...new Uint8Array(31)))).toThrow(TypeError);
  });

  it("refuses an Ed25519 encoding whose y is not reduced", () => {
    expect(() => Identity.from("ed25519", new Uint8Array(32).fill(0xff))).toThrow(TypeError);
  });

  it("refuses an Ed25519 key of small order", () => {
    const neutral = Uint8Array.of(1, ...new Uint8Array(31));
    expect(() => Identity.from("ed25519", neutral)).toThrow(TypeError);
  });

  it("keeps its key when the caller later changes the bytes it passed", () => {
    const bytes = ed25519Key.slice();
    const identity = Identity.from("ed25519", bytes);
    bytes[0]! ^= 1;
    expect(identity.publicKey).toEqual(ed25519Key);
  });
});

describe("an identity", () => {
  it("equals one with the same scheme and key", () => {
    expect(Identity.from("ed25519", ed25519Key).equals(Identity.from("ed25519", ed25519Key))).toBe(true);
  });

  it("differs from one with the same key under another scheme", () => {
    expect(Identity.from("ed25519", ed25519Key).equals(Identity.from("solana-offchain", ed25519Key))).toBe(
      false,
    );
  });
});
