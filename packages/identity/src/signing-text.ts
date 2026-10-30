import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * What every scheme signs for an object's SHA-256 digest, before its
 * framing. A key signs objects and nothing else; a login or a grant is an
 * object too, so no signature can be passed off as another kind. It
 * is text because wallets show text, and it says what it is so that a wallet
 * user asked elsewhere to sign it as, say, a login nonce can tell.
 *
 * Given the digest of a signed identity's link too, the text says the object
 * is signed by that signed identity: `Estoc Object (sha256:<hex>) by
 * (sha256:<hex>)`. A key signs that text when it signs for an identity,
 * and the bare text only when a root signs an identity, so a signature made
 * for an identity is not one by which a root stands behind an identity, and
 * one made for one signed identity is not one for another.
 */
export function signingText(digest: Uint8Array, signedIdentity?: Uint8Array): string {
  const text = `Estoc Object (sha256:${hexOf(digest)})`;
  return signedIdentity === undefined ? text : `${text} by (sha256:${hexOf(signedIdentity)})`;
}

function hexOf(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new TypeError(`a SHA-256 digest is 32 bytes, got ${digest.length}`);
  }
  return bytesToHex(digest);
}
