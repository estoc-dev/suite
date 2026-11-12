import type { EncodedObject, Link, Value } from "@estoc/object";
import { equalBytes } from "@noble/curves/utils.js";
import { signingText } from "../signing-text.ts";

/**
 * How a key signs, as a plugin gives it: the scheme's name, the length of
 * its public keys, and the code that verifies a signature in it. A key kept
 * in a chain wallet signs only in that chain's off-chain message framing, so
 * the framing belongs to the scheme, and a verifier does not accept a
 * framing its holder did not choose.
 *
 * - One signing act has one valid encoding. Signatures are stored and
 *   hashed as bytes, and a second encoding of the same signature would give
 *   the same act a second link.
 * - `name` is not that of another scheme.
 * - The text is framed as it is, not rewritten, so a key that signs it
 *   signs what it says.
 */
export interface Scheme {
  /** The title of the schema its keys are written to, which sets it apart from every other scheme's. */
  readonly name: string;
  readonly publicKeyLength: number;
  /** Whether `signature` is `publicKey`'s over `text` in this scheme. */
  verify(signature: Uint8Array, text: string, publicKey: Uint8Array): boolean;
}

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

export type KeyData = { readonly publicKey: Uint8Array };

/**
 * A key read from its object, written to the schema of its scheme. An
 * identity names its root by the link of this object.
 */
export interface KeyObject extends EncodedObject<Value, KeyData>, Key {
  readonly link: Link<KeyObject>;
}

/**
 * Whether `signature` is `key`'s signature over `signingText(digest,
 * signedIdentity)`. A key that is not a usable key in its scheme's form
 * verifies nothing.
 */
export function verify(key: Key, digest: Uint8Array, signature: Uint8Array, signedIdentity?: Uint8Array): boolean {
  const { scheme, publicKey } = key;
  return (
    publicKey.length === scheme.publicKeyLength &&
    scheme.verify(signature, signingText(digest, signedIdentity), publicKey)
  );
}

/** Whether `a` and `b` are the same key: the same scheme, which is one value in a program, and the same bytes. */
export function isSameKey(a: Key, b: Key): boolean {
  return a.scheme === b.scheme && equalBytes(a.publicKey, b.publicKey);
}
