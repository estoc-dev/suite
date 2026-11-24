import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader, readObject } from "@estoc/object";
import { type DataOf, link, schema, secretSchema } from "@estoc/schema";
import { blobsOf } from "./blobs.ts";
import { type CurveScheme, isCurveScheme } from "./key/curves.ts";
import { isSameKey, type KeyObject } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";
import { type Signer, SoftwareSigner } from "./signer.ts";

export const secretKeySchema = schema("Secret Key", { key: link(), secret: link() });

export type SecretKeyData = DataOf<typeof secretKeySchema>;

export interface SecretKeyObject {
  readonly link: Link<unknown>;
  readonly key: KeyObject;
  readonly signer: Signer;
  readonly blobs: readonly Uint8Array[];
}

export class SecretKeys {
  readonly schema = secretKeySchema;
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  schemeNamed(name: string): CurveScheme | undefined {
    const scheme = this.#keys.schemeNamed(name);
    return scheme !== undefined && isCurveScheme(scheme) ? scheme : undefined;
  }

  encode(scheme: CurveScheme, secretKey: Uint8Array): SecretKeyObject {
    const signer = SoftwareSigner.fromSecretKey(scheme, secretKey);
    const key = this.#keys.encode(signer.key);
    const secret = encodeObject(secretSchema, { bytes: secretKey });
    const object = encodeObject(this.schema, { key: new LinkValue(key.link), secret: new LinkValue(secret.link) });
    return secretKeyOf(object, key, signer, secret);
  }

  async read(link: Link<unknown>, reader: Reader): Promise<SecretKeyObject> {
    const object = await readObject(reader, link, this.schema);
    const key = await this.#keys.read(object.data.key.link, reader);
    const { scheme } = key;
    if (!isCurveScheme(scheme)) throw new Error(`the ${scheme.name} scheme is not one a curve signs in`);
    const secret = await readObject(reader, object.data.secret.link, secretSchema);
    const signer = SoftwareSigner.fromSecretKey(scheme, secret.data.bytes);
    if (!isSameKey(signer.key, key)) throw new Error(`the secret ${link} links to is not that of ${key.link}`);
    return secretKeyOf(object, key, signer, secret);
  }
}

function secretKeyOf(
  object: EncodedObject<SecretKeyData>,
  key: KeyObject,
  signer: Signer,
  secret: EncodedObject,
): SecretKeyObject {
  return { link: object.link, key, signer, blobs: blobsOf(object, [...blobsOf(secret), ...key.blobs]) };
}
