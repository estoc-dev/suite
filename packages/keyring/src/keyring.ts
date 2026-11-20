import { type CurveScheme, type KeyObject, type SecretKeys, type Signer, secretKeySchema } from "@estoc/identity";
import { type Link, LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { type Backend, indexOver, SecretStore, type Store, scan, selectedSecrets } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const byKey = indexOver(selectedSecrets(objectsOf(secretKeySchema)), heldKeySchema, ({ link, data }) => [
  { key: data.key, secretKey: new LinkValue(link) },
]).orderedBy("key");

/** Give it a backend of its own: code given that backend, or a secret store over it, reads the secrets. */
export class Keyring {
  readonly #secretStore: SecretStore;
  readonly #secretKeys: SecretKeys;

  constructor(store: Store, backend: Backend, secretKeys: SecretKeys) {
    this.#secretStore = new SecretStore(store, backend);
    this.#secretKeys = secretKeys;
  }

  async generate(scheme: CurveScheme): Promise<KeyObject> {
    const secretKey = this.#secretKeys.encode(scheme, scheme.curve.randomSecretKey());
    await this.#secretStore.write({ secrets: [secretKey.link], blobs: secretKey.blobs });
    return secretKey.key;
  }

  async signerFor(key: Link<unknown>): Promise<Signer | undefined> {
    for await (const { data } of (await scan(this.#secretStore, byKey)).range([new LinkValue(key)]))
      return (await this.#secretKeys.read(data.secretKey.link, this.#secretStore)).signer;
    return undefined;
  }
}
