import { equalBytes } from "@noble/curves/utils.js";
import { schemes, type Scheme } from "./scheme.ts";
import { signingText } from "./signing-text.ts";

/**
 * Something that signs, as others see it: a public key and the scheme it
 * signs in. Two identities are the same when both are; one key under two
 * schemes is two identities. An identity holds one key for good; acting
 * through other keys is for documents it signs to grant.
 */
export class Identity {
  readonly scheme: Scheme;
  readonly #publicKey: Uint8Array;

  private constructor(scheme: Scheme, publicKey: Uint8Array) {
    this.scheme = scheme;
    this.#publicKey = publicKey;
  }

  /**
   * Ed25519 keys are 32 bytes; secp256k1 keys are 33 bytes, compressed.
   * Throws when the bytes are not a usable key in that form.
   */
  static from(scheme: Scheme, publicKey: Uint8Array): Identity {
    if (!schemes[scheme].curve.isPublicKey(publicKey)) {
      throw new TypeError(`not a ${scheme} public key`);
    }
    return new Identity(scheme, publicKey.slice());
  }

  get publicKey(): Uint8Array {
    return this.#publicKey.slice();
  }

  equals(other: Identity): boolean {
    return this.scheme === other.scheme && equalBytes(this.#publicKey, other.#publicKey);
  }

  /** Whether `signature` is this identity's signature over `digest`. */
  verify(digest: Uint8Array, signature: Uint8Array): boolean {
    const { curve, message } = schemes[this.scheme];
    return curve.verify(signature, message(signingText(digest), this.#publicKey), this.#publicKey);
  }
}
