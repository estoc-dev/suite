import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Scheme } from "./interface.ts";

export interface Curve {
  readonly publicKeyLength: number;
  publicKeyOf(secretKey: Uint8Array): Uint8Array;
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  /** Takes a 64-byte signature and a key of `publicKeyLength` bytes. */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

/** A scheme in which a curve signs the text in a framing, as a software key or a wallet does. */
export interface CurveScheme extends Scheme {
  readonly curve: Curve;
  /** What `curve` signs for `text`: the framed text, or its hash for a curve that signs a hash. */
  message(text: string, publicKey: Uint8Array): Uint8Array;
}

/** The scheme named `name` in which `curve` signs `message(text, publicKey)`, one signature of 64 bytes. */
export function curveScheme(
  name: string,
  curve: Curve,
  message: (text: string, publicKey: Uint8Array) => Uint8Array,
): CurveScheme {
  return {
    name,
    publicKeyLength: curve.publicKeyLength,
    curve,
    message,
    verify: (signature, text, publicKey) =>
      signature.length === 64 && curve.verify(signature, message(text, publicKey), publicKey),
  };
}

// Verification is strict so that one signing act has one valid encoding:
// signatures are stored and hashed as bytes, and a second encoding of the
// same signature would give the same act a second hash. Strict Ed25519 also
// refuses small-order keys, which admit signatures that verify for many
// messages, so their holder could later deny which one was signed.
export const ed25519Curve: Curve = {
  publicKeyLength: 32,
  publicKeyOf: (secretKey) => ed25519.getPublicKey(secretKey),
  sign: (message, secretKey) => ed25519.sign(message, secretKey),
  verify: (signature, message, publicKey) => ed25519.verify(signature, message, publicKey, { zip215: false }),
};

/**
 * ECDSA on secp256k1, over a 32-byte hash.
 *
 * - It signs a hash, so what a scheme gives it is a hash of the whole framed
 *   text, as `eip191`'s Keccak-256 is. Text given as it is would be cut to
 *   its first 32 bytes, and the rest left unsigned.
 * - Signatures are compact `r || s` without the recovery byte: the public
 *   key is already known, and the byte would be one more thing to vary.
 */
export const secp256k1Curve: Curve = {
  publicKeyLength: 33,
  publicKeyOf: (secretKey) => secp256k1.getPublicKey(secretKey, true),
  sign: (hash, secretKey) => secp256k1.sign(hash, secretKey, { prehash: false }),
  verify: (signature, hash, publicKey) => secp256k1.verify(signature, hash, publicKey, { prehash: false, lowS: true }),
};
