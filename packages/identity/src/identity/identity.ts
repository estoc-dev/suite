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
import { isSameKey, type Key, type KeyObject, verify } from "../key/interface.ts";
import type { Keys } from "../key/keys.ts";
import type { Signer } from "../signer.ts";
import {
  type IdentityData,
  type IdentityImplementation,
  type IdentityObject,
  identityOf,
  type SigningFunction,
} from "./interface.ts";

/**
 * The schema of an Identity, the identity of a key on its own, whatever the
 * scheme of the key. It holds its root and `at`, and its root alone signs
 * for it. A signature for it is the root's signature.
 */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  type: "object",
  properties: { root: linkSchema, at: { type: "integer", minimum: 0 } },
  required: ["root", "at"],
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

  encode(root: Key, at: number): IdentityObject {
    const key = this.#keys.encode(root);
    return identityOf(encodeObject(this.schema, { root: { $link: key.link }, at }), this, key);
  }

  async read(object: EncodedObject<Json, IdentityData>, reader: Reader): Promise<IdentityObject> {
    return identityOf(object, this, await this.#keys.read(object.data.root.$link, reader));
  }

  signerOf(
    { root }: IdentityObject,
    object: Uint8Array,
    signature: Uint8Array,
    signedIdentity: Uint8Array,
  ): KeyObject | undefined {
    return verify(root, object, signature, signedIdentity) ? root : undefined;
  }

  signingFunction({ root }: IdentityObject, signer: Signer): SigningFunction | undefined {
    return isSameKey(signer.key, root) ? (object, signedIdentity) => signer.sign(object, signedIdentity) : undefined;
  }

  hasSigner({ root }: IdentityObject, key: KeyObject): boolean {
    return key.link === root.link;
  }
}
