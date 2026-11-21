import { type CurveScheme, type KeyObject, type SecretKeys, type Signer, secretKeySchema } from "@estoc/identity";
import { type Link, LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, type Store, scan, selectedMarks } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const byKey = indexOver(selectedMarks(objectsOf(secretKeySchema)), heldKeySchema, ({ link, data }) => [
  { key: data.key, secretKey: new LinkValue(link) },
]).orderedBy("key");

/**
 * - It signs with the Secret Keys among the marks of the store. Anyone can send a Secret Key and
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
    await this.#store.writeMarks({ marks: [link], blobs });
    return key;
  }

  async signerFor(key: Link<unknown>): Promise<Signer | undefined> {
    for await (const { data } of (await scan(this.#store, byKey)).range([new LinkValue(key)]))
      return (await this.#secretKeys.read(data.secretKey.link, this.#store)).signer;
    return undefined;
  }
}
