import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * What every scheme signs for a document's SHA-256 digest, before its
 * framing. An identity signs documents and nothing else; a login or a grant
 * is a document too, so no signature can be passed off as another kind. It
 * is text because wallets show text, and it says what it is so that a wallet
 * user asked elsewhere to sign it as, say, a login nonce can tell.
 */
export function signingText(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new TypeError(`a SHA-256 digest is 32 bytes, got ${digest.length}`);
  }
  return `Estoc Document (sha256:${bytesToHex(digest)})`;
}
