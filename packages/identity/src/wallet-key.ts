import { type EncodedObject, type Est, EstLink, encodeObject, type Link, type Reader, readObject } from "@estoc/object";
import { type DataOf, link, schema } from "@estoc/schema";
import { blobsOf } from "./blobs.ts";
import type { Key, KeyObject } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";

/**
 * The schema of a Wallet Key, kept in a device's private store for each key
 * the device signs with through a wallet.
 *
 * - It is kept private as it means something to that device alone.
 * - Which wallet holds the key, the program finds by the public key the
 *   wallet gives.
 */
export const walletKeySchema = schema("Wallet Key", { key: link<KeyObject>() });

export type WalletKeyData = DataOf<typeof walletKeySchema>;

/**
 * A Wallet Key read from its object, with its key. `blobs` are its closure,
 * as a Secret Key's are.
 */
export interface WalletKeyObject extends EncodedObject<Est, WalletKeyData> {
  readonly link: Link<WalletKeyObject>;
  readonly key: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

/** Wallet Keys, written to `walletKeySchema` and read with the keys they name. */
export class WalletKeys {
  readonly schema = walletKeySchema;
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  /** Writes the Wallet Key of `key`. */
  encode(key: Key): WalletKeyObject {
    const object = this.#keys.encode(key);
    return walletKeyOf(encodeObject(this.schema, { key: new EstLink(object.link) }), object);
  }

  /** Reads the Wallet Key that `link` names from `reader`, with its key. */
  async read(link: Link<WalletKeyObject>, reader: Reader): Promise<WalletKeyObject> {
    const object = await readObject(reader, link, this.schema);
    return walletKeyOf(object, await this.#keys.read(object.data.key.link, reader));
  }
}

function walletKeyOf(object: EncodedObject<Est, WalletKeyData>, key: KeyObject): WalletKeyObject {
  return { ...object, link: object.link as Link<WalletKeyObject>, key, blobs: blobsOf([object, key]) };
}
