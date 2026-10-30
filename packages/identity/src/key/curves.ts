import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Curve } from "./interface.ts";

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

// Signatures are compact `r || s` without the recovery byte: the public key
// is already known, and the byte would be one more thing to vary.
export const secp256k1Curve: Curve = {
  publicKeyLength: 33,
  publicKeyOf: (secretKey) => secp256k1.getPublicKey(secretKey, true),
  sign: (message, secretKey) => secp256k1.sign(message, secretKey, { prehash: false }),
  verify: (signature, message, publicKey) =>
    secp256k1.verify(signature, message, publicKey, { prehash: false, lowS: true }),
};
