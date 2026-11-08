import {
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  type Json,
  type JsonLink,
  type JsonSchema,
  type Link,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { blobsOf } from "./blobs.ts";
import { type CurveScheme, isCurveScheme } from "./key/curves.ts";
import { isSameKey, type KeyObject } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";
import { type Signer, SoftwareSigner } from "./signer.ts";

/**
 * The schema of a Secret Key, kept in a device's private store for each key
 * the device signs with by a secret in memory. With the Wallet Keys there,
 * the private store lists the keys the device signs with.
 */
export const secretKeySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Secret Key",
  type: "object",
  properties: { key: linkSchema, secret: { type: "string", pattern: "^[0-9a-f]{64}$" } },
  required: ["key", "secret"],
  additionalProperties: false,
};

export type SecretKeyData = { readonly key: JsonLink<KeyObject>; readonly secret: string };

/**
 * A Secret Key read from its object, with its key and `signer`, which signs
 * with the secret. `blobs` are its closure: the bytes of its object and of
 * its key, and the blobs of the schemas they are written to, so one write
 * puts it in an empty store.
 */
export interface SecretKeyObject extends EncodedObject<Json, SecretKeyData> {
  readonly link: Link<SecretKeyObject>;
  readonly key: KeyObject;
  readonly signer: Signer;
  readonly blobs: readonly Uint8Array[];
}

/** Secret Keys, written to `secretKeySchema` and read with the keys they name. */
export class SecretKeys {
  readonly schema: Schema<Json, SecretKeyData>;
  readonly #keys: Keys;

  constructor(schema: Schema<Json, SecretKeyData>, keys: Keys) {
    this.schema = schema;
    this.#keys = keys;
  }

  /** Writes the Secret Key of `secret`'s key in `scheme`. */
  encode(scheme: CurveScheme, secret: Uint8Array): SecretKeyObject {
    const signer = SoftwareSigner.fromSecretKey(scheme, secret);
    const key = this.#keys.encode(signer.key);
    const object = encodeObject(this.schema, { key: { $link: key.link }, secret: bytesToHex(secret) });
    return secretKeyOf(object, key, signer);
  }

  /**
   * Reads the Secret Key that `link` names from `reader`, with its key.
   *
   * @throws when the key is in a scheme no curve signs in, since a secret in
   * memory signs with a curve.
   * @throws when the secret is not that of the key.
   */
  async read(link: Link<SecretKeyObject>, reader: Reader): Promise<SecretKeyObject> {
    const object = await readObject(reader, link, this.schema);
    const key = await this.#keys.read(object.data.key.$link, reader);
    const { scheme } = key;
    if (!isCurveScheme(scheme)) throw new Error(`the ${scheme.name} scheme is not one a curve signs in`);
    const signer = SoftwareSigner.fromSecretKey(scheme, hexToBytes(object.data.secret));
    if (!isSameKey(signer.key, key)) throw new Error(`the secret ${link} holds is not that of ${key.link}`);
    return secretKeyOf(object, key, signer);
  }
}

function secretKeyOf(object: EncodedObject<Json, SecretKeyData>, key: KeyObject, signer: Signer): SecretKeyObject {
  return { ...object, link: object.link as Link<SecretKeyObject>, key, signer, blobs: blobsOf([object, key]) };
}
