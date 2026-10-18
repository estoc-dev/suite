import type { Identity } from "./identity.ts";
import { schemes, type Scheme } from "./scheme.ts";
import { signingText } from "./signing-text.ts";

/**
 * The private side of an identity, as the capability to sign for it. A
 * wallet stands behind one the same way a key in memory does, which is why
 * signing is asynchronous.
 */
export interface Signer {
  readonly identity: Identity;
  sign(digest: Uint8Array): Promise<Uint8Array>;
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
    const owned = secretKey.slice();
    return new SoftwareSigner(scheme, schemes[scheme].curve.publicKeyOf(owned), owned);
  }

  get identity(): Identity {
    return { scheme: this.#scheme, publicKey: this.#publicKey.slice() };
  }

  async sign(digest: Uint8Array): Promise<Uint8Array> {
    const { curve, message } = schemes[this.#scheme];
    return curve.sign(message(signingText(digest), this.#publicKey), this.#secretKey);
  }
}
