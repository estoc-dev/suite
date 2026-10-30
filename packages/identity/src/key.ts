import { equalBytes } from "@noble/curves/utils.js";
import { type Scheme, schemes } from "./scheme.ts";
import { signingText } from "./signing-text.ts";

/**
 * A public key and the scheme it signs in. Two keys are the same when both
 * are; one public key under two schemes is two keys.
 *
 * Ed25519 keys are 32 bytes; secp256k1 keys are 33 bytes, compressed, so
 * that each key has one form to compare.
 */
export interface Key {
  readonly scheme: Scheme;
  readonly publicKey: Uint8Array;
}

/**
 * Whether `signature` is `key`'s signature over `signingText(digest,
 * signedIdentity)`. A key that is not a usable key in its scheme's form
 * verifies nothing.
 */
export function verify(key: Key, digest: Uint8Array, signature: Uint8Array, signedIdentity?: Uint8Array): boolean {
  const { curve, message } = schemes[key.scheme];
  const { publicKey } = key;
  return (
    publicKey.length === curve.publicKeyLength &&
    signature.length === 64 &&
    curve.verify(signature, message(signingText(digest, signedIdentity), publicKey), publicKey)
  );
}

export function sameKey(a: Key, b: Key): boolean {
  return a.scheme === b.scheme && equalBytes(a.publicKey, b.publicKey);
}
