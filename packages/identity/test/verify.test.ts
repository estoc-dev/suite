import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import { signingText, SoftwareSigner, verify, type Identity, type Scheme } from "../src/index.ts";

const digest = Uint8Array.from({ length: 32 }, (_, i) => i);
const otherDigest = digest.map((byte) => byte ^ 0xff);

// The Hardhat and Anvil development account #0, so the vector can be
// reproduced with any Ethereum tooling.
const secp256k1Secret = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ed25519Secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const secrets: Record<Scheme, Uint8Array> = {
  ed25519: ed25519Secret,
  eip191: secp256k1Secret,
  "solana-offchain": ed25519Secret,
};

describe.each(["ed25519", "eip191", "solana-offchain"] as const)("a %s identity", (scheme) => {
  const signer = SoftwareSigner.fromSecretKey(scheme, secrets[scheme]);
  const other = SoftwareSigner.fromSecretKey(scheme, secrets[scheme].map((byte) => byte ^ 0x5a));

  it("verifies what its signer signs", async () => {
    expect(verify(signer.identity, digest, await signer.sign(digest))).toBe(true);
  });

  it("rejects its signature over another digest", async () => {
    expect(verify(signer.identity, otherDigest, await signer.sign(digest))).toBe(false);
  });

  it("rejects another key's signature", async () => {
    expect(verify(signer.identity, digest, await other.sign(digest))).toBe(false);
  });

  it("rejects a signature with one bit changed", async () => {
    const signature = await signer.sign(digest);
    signature[10]! ^= 1;
    expect(verify(signer.identity, digest, signature)).toBe(false);
  });

  it("rejects a signature of the wrong length", async () => {
    const signature = await signer.sign(digest);
    expect(verify(signer.identity, digest, signature.subarray(0, 63))).toBe(false);
    expect(verify(signer.identity, digest, Uint8Array.of(...signature, 0))).toBe(false);
  });
});

test("one Ed25519 key signs differently as ed25519 and as solana-offchain", async () => {
  const plain = SoftwareSigner.fromSecretKey("ed25519", ed25519Secret);
  const solana = SoftwareSigner.fromSecretKey("solana-offchain", ed25519Secret);
  expect(verify(solana.identity, digest, await plain.sign(digest))).toBe(false);
  expect(verify(plain.identity, digest, await solana.sign(digest))).toBe(false);
});

test("an eip191 identity rejects the high-s twin of its signature", async () => {
  const signer = SoftwareSigner.fromSecretKey("eip191", secp256k1Secret);
  const signature = await signer.sign(digest);
  const s = bytesToNumberBE(signature.subarray(32));
  const twin = Uint8Array.of(...signature.subarray(0, 32), ...numberToBytesBE(secp256k1.Point.CURVE().n - s, 32));
  expect(verify(signer.identity, digest, twin)).toBe(false);
});

describe("signingText", () => {
  it("names Estoc and the digest in hex", () => {
    expect(signingText(digest)).toBe(
      "Estoc signature sha256:000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
  });

  it("refuses a digest that is not 32 bytes", () => {
    expect(() => signingText(digest.subarray(1))).toThrow(TypeError);
  });
});

// Signatures made outside this package, by viem's `signMessage` and by
// `@solana/offchain-messages`, over `signingText(digest)`.
describe("signatures from chain tooling", () => {
  test("a personal_sign signature verifies, and a software signer makes the same one", async () => {
    const identity: Identity = {
      scheme: "eip191",
      publicKey: hexToBytes("038318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75"),
    };
    const withRecovery = hexToBytes(
      "999f863c546fb4d1a301568b792488222d9c9f6031e4e521609cc775930beea3" +
        "6967721fd6f562f8e21f9c61090ffc8796f264d684974b8d63b32bec9083f3491b",
    );
    const signature = withRecovery.subarray(0, 64);
    expect(verify(identity, digest, signature)).toBe(true);
    expect(await SoftwareSigner.fromSecretKey("eip191", secp256k1Secret).sign(digest)).toEqual(signature);
  });

  test("a version 1 off-chain message signature verifies, and a software signer makes the same one", async () => {
    const identity: Identity = {
      scheme: "solana-offchain",
      publicKey: hexToBytes("79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"),
    };
    const signature = hexToBytes(
      "3749f108e1dd1b8fcd47c339209654fef5c3a2e8eeb7fc59149eead0956280ac" +
        "989b21932dc0a34b3668cb534672fe80d39e07a7b0fd4c14dd16384b2caed906",
    );
    expect(verify(identity, digest, signature)).toBe(true);
    expect(await SoftwareSigner.fromSecretKey("solana-offchain", ed25519Secret).sign(digest)).toEqual(signature);
  });
});
