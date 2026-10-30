import {
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  type Json,
  type JsonSchema,
  linkSchema,
  type Reader,
  type Schema,
} from "@estoc/object";
import { type Key, type KeyObject, sameKey, verify } from "../key/interface.ts";
import type { Keys } from "../key/keys.ts";
import type { Signer } from "../signer.ts";
import {
  type IdentityData,
  type IdentityImplementation,
  type IdentityObject,
  identityInterface,
  identityOf,
  type Sign,
} from "./interface.ts";

/**
 * The schema of an Identity, the identity of a key on its own, whatever the
 * scheme of the key. It holds its root and nothing else, so each key has
 * one, with one link, and its root alone signs for it. A signature for it is
 * the root's signature.
 */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  "x-implements": { $link: identityInterface.link },
  type: "object",
  properties: { root: linkSchema },
  required: ["root"],
  additionalProperties: false,
};

/** Identities, written to `identitySchema` and read with the keys they name. */
export class Identities implements IdentityImplementation {
  readonly schema: Schema<Json, IdentityData>;
  readonly #keys: Keys;

  constructor(schema: Schema<Json, IdentityData>, keys: Keys) {
    this.schema = schema;
    this.#keys = keys;
  }

  /** Writes the Identity whose root is `root`. */
  encode(root: Key): IdentityObject {
    const key = this.#keys.encode(root);
    return identityOf(encodeObject(this.schema, { root: { $link: key.link } }), key);
  }

  async read(object: EncodedObject<Json, IdentityData>, reader: Reader): Promise<IdentityObject> {
    return identityOf(object, await this.#keys.read(object.data.root.$link, reader));
  }

  verify(
    { root }: IdentityObject,
    object: Uint8Array,
    signature: Uint8Array,
    signedIdentity: Uint8Array,
  ): KeyObject | undefined {
    return verify(root, object, signature, signedIdentity) ? root : undefined;
  }

  signing({ root }: IdentityObject, signer: Signer): Sign | undefined {
    return sameKey(signer.key, root) ? (object, signedIdentity) => signer.sign(object, signedIdentity) : undefined;
  }

  signs({ root }: IdentityObject, key: KeyObject): boolean {
    return key.link === root.link;
  }
}
