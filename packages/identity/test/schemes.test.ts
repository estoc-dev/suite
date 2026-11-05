import { encodeObject, encodeSchema, type Json, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { ed25519 as edwards } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, bytesToNumberLE, numberToBytesBE, numberToBytesLE } from "@noble/curves/utils.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, test } from "vitest";
import { checkScheme } from "../src/conformance.ts";
import {
  curveScheme,
  ed25519,
  ed25519Curve,
  eip191,
  isSameKey,
  loadIdentity,
  noVersions,
  type Scheme,
  type Signer,
  SoftwareSigner,
  secp256k1Curve,
  signingText,
  solanaOffchain,
} from "../src/index.ts";
import { schemes } from "./fixtures.ts";

const secretKey = new Uint8Array(32).fill(1);

// An Ed25519 signature `R || S` with the group order added to S, which a
// verifier that does not check S against it would take.
const withOrderAdded = (signature: Uint8Array) => {
  const s = bytesToNumberLE(signature.subarray(32)) + edwards.Point.CURVE().n;
  return Uint8Array.of(...signature.subarray(0, 32), ...numberToBytesLE(s, 32));
};

// A secp256k1 signature `r || s` with s negated, which a verifier that takes
// high s would take.
const withSNegated = (signature: Uint8Array) => {
  const s = secp256k1.Point.CURVE().n - bytesToNumberBE(signature.subarray(32));
  return Uint8Array.of(...signature.subarray(0, 32), ...numberToBytesBE(s, 32));
};

// A scheme written as a `Scheme` alone, with no curve of this package: P-256
// over the SHA-256 of the text, its signatures in DER and of no fixed
// length, as a passkey's are.
const p256Der: Scheme = {
  name: "p256-der",
  publicKeyLength: 33,
  verify: (signature, text, publicKey) =>
    p256.verify(signature, utf8ToBytes(text), publicKey, { format: "der", lowS: true }),
};
const p256Signer: Signer = {
  key: { scheme: p256Der, publicKey: p256.getPublicKey(secretKey, true) },
  sign: async (digest, signedIdentity) =>
    p256.sign(utf8ToBytes(signingText(digest, signedIdentity)), secretKey, { format: "der", lowS: true }),
};
const withDerSNegated = (signature: Uint8Array) => {
  const { r, s } = p256.Signature.fromBytes(signature, "der");
  return new p256.Signature(r, p256.Point.CURVE().n - s).toBytes("der");
};

test.each([
  { scheme: ed25519, reencoded: withOrderAdded },
  { scheme: eip191, reencoded: withSNegated },
  { scheme: solanaOffchain, reencoded: withOrderAdded },
])("$scheme.name keeps the rules for a scheme", async ({ scheme, reencoded }) => {
  expect(await checkScheme(scheme, SoftwareSigner.fromSecretKey(scheme, secretKey), reencoded)).toEqual([]);
});

describe("a scheme", () => {
  it("that takes high s breaks the rule of one encoding for each signature", async () => {
    const lax = curveScheme(
      "eip191-lax",
      {
        ...secp256k1Curve,
        verify: (signature, message, publicKey) =>
          secp256k1.verify(signature, message, publicKey, { prehash: false, lowS: false }),
      },
      eip191.message,
    );
    expect(await checkScheme(lax, SoftwareSigner.fromSecretKey(lax, secretKey), withSNegated)).toEqual([
      "another encoding of a signature verifies",
    ]);
  });

  it("that gives a curve that signs a hash the text itself breaks the rules of what it verifies", async () => {
    const unhashedScheme = curveScheme("secp256k1-text", secp256k1Curve, (text) => utf8ToBytes(text));
    expect(
      await checkScheme(unhashedScheme, SoftwareSigner.fromSecretKey(unhashedScheme, secretKey), withSNegated),
    ).toEqual([
      "a signature verifies for another digest",
      "a signature verifies by another signed identity",
      "a signature by a signed identity verifies by none",
      "a signature by none verifies by a signed identity",
    ]);
  });

  it("that does not verify the text breaks every rule of what it verifies", async () => {
    const accepting: Scheme = { name: "accepting", publicKeyLength: 32, verify: () => true };
    const signer: Signer = {
      key: { scheme: accepting, publicKey: new Uint8Array(32) },
      sign: async () => new Uint8Array(64),
    };
    expect(await checkScheme(accepting, signer, (signature) => signature.map((byte) => byte ^ 1))).toEqual([
      "a signature verifies for another digest",
      "a signature verifies by another signed identity",
      "a signature by a signed identity verifies by none",
      "a signature by none verifies by a signed identity",
      "another encoding of a signature verifies",
    ]);
  });
});

describe("a scheme given as a Scheme alone", () => {
  it("keeps the rules for a scheme", async () => {
    expect(await checkScheme(p256Der, p256Signer, withDerSNegated)).toEqual([]);
  });

  it("signs for an identity, with signatures of its own length", async () => {
    const { signatures, publish } = await loadIdentity(defaultValidator, [ed25519, p256Der]);
    const note: Schema<Json, { readonly text: string }> = await encodeSchema(
      { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      defaultValidator,
    );
    const signature = await signatures
      .actor(p256Signer, await publish(p256Signer))
      .sign(encodeObject(note, { text: "hello" }));
    const blobs = new Map(signature.signedIdentity.blobs.map((bytes) => [linkOf(bytes), bytes]));
    const read = await signatures.verify(signature, blobs, noVersions);
    expect(isSameKey(read.key, p256Signer.key)).toBe(true);
    expect(read.signature.length).not.toBe(64);
  });
});

describe("loadIdentity", () => {
  it("reads and writes keys in the schemes it is given alone", async () => {
    const { keys } = await loadIdentity(defaultValidator, [ed25519]);
    const { keys: everyKey } = await loadIdentity(defaultValidator, schemes);
    const key = SoftwareSigner.fromSecretKey(eip191, secretKey).key;
    const object = everyKey.encode(key);
    expect(() => keys.encode(key)).toThrow("the eip191 scheme is not one written here");
    await expect(keys.read(object.link, new Map([[object.link, object.bytes]]))).rejects.toThrow(
      `${object.schema.link} is not a schema read here`,
    );
  });

  it("refuses two schemes with one object", async () => {
    const copy = curveScheme("ed25519", ed25519Curve, ed25519.message);
    await expect(loadIdentity(defaultValidator, [ed25519, copy])).rejects.toThrow(/is given two implementations/);
  });
});
