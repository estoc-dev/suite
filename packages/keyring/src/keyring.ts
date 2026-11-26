import type { CurveScheme, KeyObject, SecretKeys, Signer } from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import type { Store } from "@estoc/store";
import { heldKeys } from "./held-keys.ts";

/**
 * - It signs with the Secret Keys among the records of the store. Anyone can send a Secret Key and
 *   its Secret in a bundle, and one that only came to the store gives no signer.
 * - What is given the store reads the bytes of every key, so the signers this hands out are a
 *   shape for callers to work with and no boundary.
 */
export class Keyring {
  readonly #store: Store;
  readonly #secretKeys: SecretKeys;

  constructor(store: Store, secretKeys: SecretKeys) {
    this.#store = store;
    this.#secretKeys = secretKeys;
  }

  async generate(scheme: CurveScheme): Promise<KeyObject> {
    const { link, key, blobs } = this.#secretKeys.encode(scheme, scheme.curve.randomSecretKey());
    await this.#store.record({ statements: [link], blobs });
    return key;
  }

  async signerFor(key: Link<unknown>): Promise<Signer | undefined> {
    for await (const { data } of (await this.#store.scan(heldKeys)).orderedBy("key").range([new LinkValue(key)]))
      return (await this.#secretKeys.read(data.secretKey.link, this.#store)).signer;
    return undefined;
  }
}
