import type { Key } from "./key.ts";
import { type Scheme, schemes } from "./scheme.ts";
import { signingText } from "./signing-text.ts";

/**
 * The private side of a key, as the capability to sign with it. A wallet
 * stands behind one the same way a key in memory does, which is why signing
 * is asynchronous. It signs `signingText(digest, signedIdentity)` in its
 * key's scheme.
 */
export interface Signer {
  readonly key: Key;
  sign(digest: Uint8Array, signedIdentity?: Uint8Array): Promise<Uint8Array>;
}

/** A signer over a secret key held in memory. */
export class SoftwareSigner implements Signer {
  readonly #scheme: Scheme;
  readonly #publicKey: Uint8Array;
  readonly #secretKey: Uint8Array;

  private constructor(scheme: Scheme, publicKey: Uint8Array, secretKey: Uint8Array) {
    this.#scheme = scheme;
    this.#publicKey = publicKey;
    this.#secretKey = secretKey;
  }

  static fromSecretKey(scheme: Scheme, secretKey: Uint8Array): SoftwareSigner {
    const owned = new Uint8Array(secretKey);
    return new SoftwareSigner(scheme, schemes[scheme].curve.publicKeyOf(owned), owned);
  }

  get key(): Key {
    return { scheme: this.#scheme, publicKey: this.#publicKey.slice() };
  }

  async sign(digest: Uint8Array, signedIdentity?: Uint8Array): Promise<Uint8Array> {
    const { curve, message } = schemes[this.#scheme];
    return curve.sign(message(signingText(digest, signedIdentity), this.#publicKey), this.#secretKey);
  }
}
