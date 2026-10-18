import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * What every scheme signs for a SHA-256 digest, before its framing. It is
 * text because wallets show text, and it names Estoc so that a wallet user
 * asked to sign it elsewhere, passed off as a login nonce, can see what it is.
 */
export function signingText(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new TypeError(`a SHA-256 digest is 32 bytes, got ${digest.length}`);
  }
  return `Estoc signature sha256:${bytesToHex(digest)}`;
}
