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
  it("names an Estoc document by its digest in hex", () => {
    expect(signingText(digest)).toBe(
      "Estoc Document (sha256:000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f)",
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
      "413ea7b7099a6b06c70dc15263bfa309e1ac30a1d537e2a10b4eacd89026d9da" +
        "1d2227ae4e8305a42a4c172a2ed839e55ad73ebbde1e85e3c3c99a3ff741aab71c",
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
      "b817caa75ba07218f678852c2dd785290e4216c59e5411966894b71341a0f95c" +
        "31fefa01ff854bf59dcb4fdc15cbec839661029f7025c8ae2aad15d4394ec000",
    );
    expect(verify(identity, digest, signature)).toBe(true);
    expect(await SoftwareSigner.fromSecretKey("solana-offchain", ed25519Secret).sign(digest)).toEqual(signature);
  });
});
