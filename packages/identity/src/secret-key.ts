import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader, readObject } from "@estoc/object";
import { bytes, type DataOf, link, schema } from "@estoc/schema";
import { blobsOf } from "./blobs.ts";
import { type CurveScheme, isCurveScheme } from "./key/curves.ts";
import { isSameKey, type KeyObject } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";
import { type Signer, SoftwareSigner } from "./signer.ts";

export const secretKeySchema = schema("Secret Key", { key: link(), secret: bytes() });

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

  encode(scheme: CurveScheme, secret: Uint8Array): SecretKeyObject {
    const signer = SoftwareSigner.fromSecretKey(scheme, secret);
    const key = this.#keys.encode(signer.key);
    const object = encodeObject(this.schema, { key: new LinkValue(key.link), secret });
    return secretKeyOf(object, key, signer);
  }

  async read(link: Link<unknown>, reader: Reader): Promise<SecretKeyObject> {
    const object = await readObject(reader, link, this.schema);
    const key = await this.#keys.read(object.data.key.link, reader);
    const { scheme } = key;
    if (!isCurveScheme(scheme)) throw new Error(`the ${scheme.name} scheme is not one a curve signs in`);
    const signer = SoftwareSigner.fromSecretKey(scheme, object.data.secret);
    if (!isSameKey(signer.key, key)) throw new Error(`the secret ${link} holds is not that of ${key.link}`);
    return secretKeyOf(object, key, signer);
  }
}

function secretKeyOf(object: EncodedObject<SecretKeyData>, key: KeyObject, signer: Signer): SecretKeyObject {
  return { link: object.link, key, signer, blobs: blobsOf(object, key.blobs) };
}
