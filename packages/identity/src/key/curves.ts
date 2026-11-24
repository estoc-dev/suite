import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Scheme } from "./interface.ts";

export interface Curve {
  readonly publicKeyLength: number;
  randomSecretKey(): Uint8Array;
  publicKeyOf(secretKey: Uint8Array): Uint8Array;
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

/**
 * - `curveScheme` alone makes one. A scheme that only verifies may have a member named `curve`
 *   too, and no curve signs in it.
 * - Its curve is in a private field, so that TypeScript takes no object of the same members for
 *   one.
 */
export class CurveScheme implements Scheme {
  readonly name: string;
  readonly publicKeyLength: number;
  readonly message: (text: string, publicKey: Uint8Array) => Uint8Array;
  readonly verify: (signature: Uint8Array, text: string, publicKey: Uint8Array) => boolean;
  readonly #curve: Curve;

  constructor(name: string, curve: Curve, message: (text: string, publicKey: Uint8Array) => Uint8Array) {
    this.name = name;
    this.publicKeyLength = curve.publicKeyLength;
    this.message = message;
    this.verify = (signature, text, publicKey) =>
      signature.length === 64 && curve.verify(signature, message(text, publicKey), publicKey);
    this.#curve = curve;
  }

  get curve(): Curve {
    return this.#curve;
  }
}

export function isCurveScheme(scheme: Scheme): scheme is CurveScheme {
  return scheme instanceof CurveScheme;
}

export function curveScheme(
  name: string,
  curve: Curve,
  message: (text: string, publicKey: Uint8Array) => Uint8Array,
): CurveScheme {
  return new CurveScheme(name, curve, message);
}

// Verification is strict so that one signing act has one valid encoding:
// signatures are stored and hashed as bytes, and a second encoding of the
// same signature would give the same act a second hash. Strict Ed25519 also
// refuses small-order keys, which admit signatures that verify for many
// messages, so their holder could later deny which one was signed.
export const ed25519Curve: Curve = {
  publicKeyLength: 32,
  randomSecretKey: () => ed25519.utils.randomSecretKey(),
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
  randomSecretKey: () => secp256k1.utils.randomSecretKey(),
  publicKeyOf: (secretKey) => secp256k1.getPublicKey(secretKey, true),
  sign: (hash, secretKey) => secp256k1.sign(hash, secretKey, { prehash: false }),
  verify: (signature, hash, publicKey) => secp256k1.verify(signature, hash, publicKey, { prehash: false, lowS: true }),
};
