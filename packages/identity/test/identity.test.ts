import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, test } from "vitest";
import { sameIdentity, SoftwareSigner, verify, type Identity } from "../src/index.ts";

const digest = Uint8Array.from({ length: 32 }, (_, i) => i);
const ed25519Signer = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const secp256k1Signer = SoftwareSigner.fromSecretKey("eip191", new Uint8Array(32).fill(1));

describe("an identity whose key is not in its scheme's form", () => {
  it("verifies nothing with an uncompressed secp256k1 key", async () => {
    const compressed = secp256k1Signer.identity.publicKey;
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    const identity: Identity = { scheme: "eip191", publicKey: uncompressed };
    expect(verify(identity, digest, await secp256k1Signer.sign(digest))).toBe(false);
  });

  it("verifies nothing with a key of the length another scheme uses", async () => {
    const identity: Identity = { scheme: "ed25519", publicKey: secp256k1Signer.identity.publicKey };
    expect(verify(identity, digest, await ed25519Signer.sign(digest))).toBe(false);
  });

  it("verifies nothing, without throwing, with bytes that are not a point on the curve", () => {
    const signature = new Uint8Array(64).fill(1);
    const offCurve: Identity[] = [
      { scheme: "ed25519", publicKey: Uint8Array.of(2, ...new Uint8Array(31)) },
      { scheme: "ed25519", publicKey: new Uint8Array(32).fill(0xff) },
      { scheme: "eip191", publicKey: Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xff)) },
    ];
    for (const identity of offCurve) expect(verify(identity, digest, signature)).toBe(false);
  });

  it("verifies nothing with an Ed25519 key of small order", () => {
    const neutral = Uint8Array.of(1, ...new Uint8Array(31));
    const anyMessage = Uint8Array.of(...neutral, ...new Uint8Array(32));
    expect(verify({ scheme: "ed25519", publicKey: neutral }, digest, anyMessage)).toBe(false);
  });
});

test("an identity still verifies after structuredClone", async () => {
  const signature = await ed25519Signer.sign(digest);
  expect(verify(structuredClone(ed25519Signer.identity), digest, signature)).toBe(true);
});

test.each(["ed25519", "eip191", "solana-offchain"] as const)(
  "%s: a signer made from a Buffer keeps signing for its key after the caller clears the Buffer",
  async (scheme) => {
    const secretKey = Buffer.from(new Uint8Array(32).fill(1));
    const signer = SoftwareSigner.fromSecretKey(scheme, secretKey);
    const identity = signer.identity;
    secretKey.fill(0);
    expect(verify(identity, digest, await signer.sign(digest))).toBe(true);
  },
);

test("a signer keeps signing for its key after the caller changes the identity it handed out", async () => {
  const handedOut = ed25519Signer.identity;
  handedOut.publicKey[0]! ^= 1;
  expect(verify(ed25519Signer.identity, digest, await ed25519Signer.sign(digest))).toBe(true);
});

describe("sameIdentity", () => {
  it("holds for the same key in the same scheme, held in different arrays", () => {
    expect(sameIdentity(ed25519Signer.identity, structuredClone(ed25519Signer.identity))).toBe(true);
  });

  it("does not hold for the same key in another scheme", () => {
    const solana = SoftwareSigner.fromSecretKey("solana-offchain", new Uint8Array(32).fill(1));
    expect(sameIdentity(ed25519Signer.identity, solana.identity)).toBe(false);
  });

  it("does not hold for another key in the same scheme", () => {
    const other = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2));
    expect(sameIdentity(ed25519Signer.identity, other.identity)).toBe(false);
  });
});
