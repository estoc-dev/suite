import { unpackBundle, type Bundle } from "@estoc/bundle";
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { base64urlnopad } from "@scure/base";

// HPKE (RFC 9180) in base mode, which seals to the receiver's key alone and
// so does not say who sealed.
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const info = new TextEncoder().encode("Estoc Message");

/** Reads a mailbox's `key` as a key to seal to; any 32 bytes are an x25519 public key. */
export function publicKeyFrom(bytes: Uint8Array): Promise<CryptoKey> {
  return suite.kem.deserializePublicKey(bytes);
}

/** Seals `plaintext` to `publicKey`: the encapsulated key, `enc`, followed by the ciphertext. */
export async function seal(publicKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const { enc, ct } = await suite.seal({ recipientPublicKey: publicKey, info }, plaintext);
  const sealed = new Uint8Array(enc.byteLength + ct.byteLength);
  sealed.set(new Uint8Array(enc));
  sealed.set(new Uint8Array(ct), enc.byteLength);
  return sealed;
}

/**
 * The x25519 key pair of whoever receives at a mailbox. `publicKey` is what
 * the mailbox's `key` holds. The holder keeps the 32 secret bytes, as for
 * a signer, so the same key opens messages after a restart.
 */
export class MailboxKey {
  readonly #keys: CryptoKeyPair;
  readonly #publicKey: Uint8Array;

  private constructor(keys: CryptoKeyPair, publicKey: Uint8Array) {
    this.#keys = keys;
    this.#publicKey = publicKey;
  }

  static async fromSecretKey(secretKey: Uint8Array): Promise<MailboxKey> {
    const privateKey = await suite.kem.deserializePrivateKey(secretKey);
    // Web Crypto derives no X25519 public key on its own, but exports one in
    // the JWK of a private key.
    const { x } = await crypto.subtle.exportKey("jwk", privateKey);
    const publicKey = base64urlnopad.decode(x!);
    return new MailboxKey({ privateKey, publicKey: await publicKeyFrom(publicKey) }, publicKey);
  }

  get publicKey(): Uint8Array {
    return this.#publicKey.slice();
  }

  /**
   * Opens sealed bytes to the bundle inside. Refuses bytes that do not open
   * with this key, and what opens but does not unpack to a bundle.
   */
  async open(sealed: Uint8Array): Promise<Bundle> {
    const { encSize } = suite.kem;
    let plaintext: ArrayBuffer;
    try {
      plaintext = await suite.open({ recipientKey: this.#keys, enc: sealed.subarray(0, encSize), info }, sealed.subarray(encSize));
    } catch (cause) {
      throw new Error("the sealed bytes do not open with this key", { cause });
    }
    return unpackBundle(new Uint8Array(plaintext));
  }
}
