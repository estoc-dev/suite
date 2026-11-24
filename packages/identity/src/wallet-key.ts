import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader, readObject } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { distinctBlobsOf } from "./blobs.ts";
import type { Key, KeyObject } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";

/**
 * It is kept private, as it means something to that device alone, and does not say which wallet
 * holds the key: the program finds that by the public key the wallet gives.
 */
export const walletKeySchema = schema("Wallet Key", { key: link() });

export type WalletKeyData = DataOf<typeof walletKeySchema>;

export interface WalletKeyObject {
  readonly link: Link<unknown>;
  readonly key: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

export class WalletKeys {
  readonly schema = walletKeySchema;
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  encode(key: Key): WalletKeyObject {
    const object = this.#keys.encode(key);
    return walletKeyOf(encodeObject(this.schema, { key: new LinkValue(object.link) }), object);
  }

  async read(link: Link<unknown>, reader: Reader): Promise<WalletKeyObject> {
    const object = await readObject(reader, link, this.schema);
    return walletKeyOf(object, await this.#keys.read(object.data.key.link, reader));
  }
}

function walletKeyOf(object: EncodedObject<WalletKeyData>, key: KeyObject): WalletKeyObject {
  return { link: object.link, key, blobs: distinctBlobsOf(object, key.blobs) };
}
