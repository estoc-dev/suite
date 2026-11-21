import { type CurveScheme, type KeyObject, type SecretKeys, type Signer, secretKeySchema } from "@estoc/identity";
import { type Link, LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, type Marks, type Secrets, type Store, scan, selectedMarks } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const byKey = indexOver(selectedMarks(objectsOf(secretKeySchema)), heldKeySchema, ({ link, data }) => [
  { key: data.key, secretKey: new LinkValue(link) },
]).orderedBy("key");

/**
 * - It signs with the Secret Keys it marked, so one that only came to the store gives no signer.
 * - What is given `secrets` reads the bytes of every key, so a program gives it to the keyring
 *   and hands the rest the keyring, for the signers.
 */
export class Keyring {
  readonly #store: Store;
  readonly #marks: Marks;
  readonly #secrets: Secrets;
  readonly #secretKeys: SecretKeys;

  constructor(store: Store, marks: Marks, secrets: Secrets, secretKeys: SecretKeys) {
    this.#store = store;
    this.#marks = marks;
    this.#secrets = secrets;
    this.#secretKeys = secretKeys;
  }

  /**
   * The Secret is written first and the mark of the Secret Key after, so a stop in between leaves
   * a Secret that no key reaches.
   */
  async generate(scheme: CurveScheme): Promise<KeyObject> {
    const { link, key, secret, blobs } = this.#secretKeys.encode(scheme, scheme.curve.randomSecretKey());
    await this.#secrets.write({ roots: [secret.link], blobs: [secret.bytes, ...secret.schema.blobs] });
    await this.#marks.write({ marks: [link], blobs });
    return key;
  }

  async signerFor(key: Link<unknown>): Promise<Signer | undefined> {
    for await (const { data } of (await scan(this.#store, byKey)).range([new LinkValue(key)]))
      return (await this.#secretKeys.read(data.secretKey.link, this.#secrets)).signer;
    return undefined;
  }
}
