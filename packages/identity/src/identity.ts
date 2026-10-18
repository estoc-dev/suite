import { schemes, type Scheme } from "./scheme.ts";
import { signingText } from "./signing-text.ts";

/**
 * Something that signs, as others see it: a public key and the scheme it
 * signs in. Two identities are the same when both are; one key under two
 * schemes is two identities. An identity holds one key for good; acting
 * through other keys is for documents it signs to grant.
 *
 * Ed25519 keys are 32 bytes; secp256k1 keys are 33 bytes, compressed, so
 * that each key has one form to compare.
 */
export interface Identity {
  readonly scheme: Scheme;
  readonly publicKey: Uint8Array;
}

/**
 * Whether `signature` is `identity`'s signature over `digest`. An identity
 * whose key is not a usable key in its scheme's form verifies nothing.
 */
export function verify(identity: Identity, digest: Uint8Array, signature: Uint8Array): boolean {
  const { curve, message } = schemes[identity.scheme];
  const { publicKey } = identity;
  return (
    publicKey.length === curve.publicKeyLength &&
    signature.length === 64 &&
    curve.verify(signature, message(signingText(digest), publicKey), publicKey)
  );
}
