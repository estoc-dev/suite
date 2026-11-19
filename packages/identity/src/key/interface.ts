import type { Link } from "@estoc/object";
import { equalBytes } from "@noble/curves/utils.js";
import { signingText } from "../signing-text.ts";

/**
 * A key kept in a chain wallet signs only in that chain's off-chain message framing, so the framing
 * belongs to the scheme, and a verifier does not accept a framing its holder did not choose.
 *
 * - One signing act has one valid encoding. Signatures are stored and hashed as bytes, and a second
 *   encoding of the same signature would give the same act a second link.
 * - The text is framed as it is, not rewritten, so a key that signs it signs what it says.
 * - A plugin takes this package as a peer dependency. A key's scheme is compared as a value, so a
 *   program holds one copy of this package.
 * - A scheme is picked by the link of its schema, so a plugin with a bug wrongly accepts signatures
 *   by keys in its own scheme alone. Its code is trusted as the application that picks it is.
 */
export interface Scheme {
  readonly name: string;
  readonly publicKeyLength: number;
  verify(signature: Uint8Array, text: string, publicKey: Uint8Array): boolean;
}

/** secp256k1 keys are 33 bytes, compressed, so that each key has one form to compare. */
export interface Key {
  readonly scheme: Scheme;
  readonly publicKey: Uint8Array;
}

export type KeyData = { readonly publicKey: Uint8Array };

export interface KeyObject extends Key {
  readonly link: Link<unknown>;
  readonly blobs: readonly Uint8Array[];
}

export function verify(key: Key, digest: Uint8Array, signature: Uint8Array, signedIdentity?: Uint8Array): boolean {
  const { scheme, publicKey } = key;
  return (
    publicKey.length === scheme.publicKeyLength &&
    scheme.verify(signature, signingText(digest, signedIdentity), publicKey)
  );
}

export function isSameKey(a: Key, b: Key): boolean {
  return a.scheme === b.scheme && equalBytes(a.publicKey, b.publicKey);
}
