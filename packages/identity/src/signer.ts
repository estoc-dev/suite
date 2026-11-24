import type { CurveScheme } from "./key/curves.ts";
import type { Key } from "./key/interface.ts";
import { signingText } from "./signing-text.ts";

/**
 * A wallet stands behind a signer the same way a key in memory does, which is why signing is
 * asynchronous.
 */
export interface Signer {
  readonly key: Key;
  sign(digest: Uint8Array, signedIdentity?: Uint8Array): Promise<Uint8Array>;
}

export class SoftwareSigner implements Signer {
  readonly key: Key;
  readonly #scheme: CurveScheme;
  readonly #secretKey: Uint8Array;

  private constructor(scheme: CurveScheme, secretKey: Uint8Array) {
    this.key = { scheme, publicKey: scheme.curve.publicKeyOf(secretKey) };
    this.#scheme = scheme;
    this.#secretKey = secretKey;
  }

  static fromSecretKey(scheme: CurveScheme, secretKey: Uint8Array): SoftwareSigner {
    return new SoftwareSigner(scheme, secretKey);
  }

  async sign(digest: Uint8Array, signedIdentity?: Uint8Array): Promise<Uint8Array> {
    const scheme = this.#scheme;
    return scheme.curve.sign(scheme.message(signingText(digest, signedIdentity), this.key.publicKey), this.#secretKey);
  }
}
