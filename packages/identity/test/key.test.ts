import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, test } from "vitest";
import { ed25519, eip191, type Key, SoftwareSigner, sameKey, solanaOffchain, verify } from "../src/index.ts";
import { schemes } from "./fixtures.ts";

const digest = Uint8Array.from({ length: 32 }, (_, i) => i);
const ed25519Signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const secp256k1Signer = SoftwareSigner.fromSecretKey(eip191, new Uint8Array(32).fill(1));

describe("a key whose public key is not in its scheme's form", () => {
  it("verifies nothing with an uncompressed secp256k1 key", async () => {
    const compressed = secp256k1Signer.key.publicKey;
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    const key: Key = { scheme: eip191, publicKey: uncompressed };
    expect(verify(key, digest, await secp256k1Signer.sign(digest))).toBe(false);
  });

  it("verifies nothing with a public key of the length another scheme uses", async () => {
    const key: Key = { scheme: ed25519, publicKey: secp256k1Signer.key.publicKey };
    expect(verify(key, digest, await ed25519Signer.sign(digest))).toBe(false);
  });

  it("verifies nothing, without throwing, with bytes that are not a point on the curve", () => {
    const signature = new Uint8Array(64).fill(1);
    const offCurve: Key[] = [
      { scheme: ed25519, publicKey: Uint8Array.of(2, ...new Uint8Array(31)) },
      { scheme: ed25519, publicKey: new Uint8Array(32).fill(0xff) },
      { scheme: eip191, publicKey: Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xff)) },
    ];
    for (const key of offCurve) expect(verify(key, digest, signature)).toBe(false);
  });

  it("verifies nothing with an Ed25519 public key of small order", () => {
    const neutral = Uint8Array.of(1, ...new Uint8Array(31));
    const anyMessage = Uint8Array.of(...neutral, ...new Uint8Array(32));
    expect(verify({ scheme: ed25519, publicKey: neutral }, digest, anyMessage)).toBe(false);
  });
});

test.each(schemes)(
  "$name: a signer made from a Buffer keeps signing for its key after the caller clears the Buffer",
  async (scheme) => {
    const secretKey = Buffer.from(new Uint8Array(32).fill(1));
    const signer = SoftwareSigner.fromSecretKey(scheme, secretKey);
    const key = signer.key;
    secretKey.fill(0);
    expect(verify(key, digest, await signer.sign(digest))).toBe(true);
  },
);

test("a signer keeps signing for its key after the caller changes the key it handed out", async () => {
  const handedOut = ed25519Signer.key;
  handedOut.publicKey.fill(0);
  expect(verify(ed25519Signer.key, digest, await ed25519Signer.sign(digest))).toBe(true);
});

describe("sameKey", () => {
  it("holds for the same public key in the same scheme, held in different arrays", () => {
    const { scheme, publicKey } = ed25519Signer.key;
    expect(sameKey(ed25519Signer.key, { scheme, publicKey: publicKey.slice() })).toBe(true);
  });

  it("does not hold for the same public key in another scheme", () => {
    const solana = SoftwareSigner.fromSecretKey(solanaOffchain, new Uint8Array(32).fill(1));
    expect(sameKey(ed25519Signer.key, solana.key)).toBe(false);
  });

  it("does not hold for another public key in the same scheme", () => {
    const other = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
    expect(sameKey(ed25519Signer.key, other.key)).toBe(false);
  });
});
