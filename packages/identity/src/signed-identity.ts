import {
  DRAFT_2020_12,
  digestOf,
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
import { hexSchema } from "./hex.ts";
import type { Identities, IdentityObject } from "./identity.ts";
import { verify } from "./key/interface.ts";
import type { Signer } from "./signer.ts";

/** The schema every signed identity is written to, whatever the scheme of its root. */
export const signedIdentitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Signed Identity",
  type: "object",
  properties: { identity: linkSchema, signature: hexSchema },
  required: ["identity", "signature"],
  additionalProperties: false,
};

export type SignedIdentityData = { readonly identity: JsonLink<IdentityObject>; readonly signature: string };

/**
 * An identity as its root publishes it: an object written to
 * `signedIdentitySchema`, read with the identity and verified.
 *
 * - `signature` holds the root's signature over the identity's link.
 * - What the root publishes is this object as it is, so a signature names
 *   the identity it is made for by the link of this object.
 * - Two signers are the same someone when the roots of their identities are
 *   the same, whichever signed identities they sign by.
 * - `blobs` are what it takes to read it again: the bytes of its object, the
 *   blobs of its schema, and the identity's `blobs`.
 */
export interface SignedIdentityObject extends EncodedObject<Json, SignedIdentityData> {
  readonly link: Link<SignedIdentityObject>;
  readonly identity: IdentityObject;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/** Signed identities, with the identities they sign. */
export class SignedIdentities {
  readonly schema: Schema<Json, SignedIdentityData>;
  readonly #identities: Identities;

  constructor(schema: Schema<Json, SignedIdentityData>, identities: Identities) {
    this.schema = schema;
    this.#identities = identities;
  }

  /**
   * Verifies `object`, giving it with its identity, the keys it names and the
   * signed identities it follows, each verified, all read from `reader`. An
   * identity stands for someone only as its root signed it, which reading its
   * object and keys alone does not verify.
   *
   * @throws when `object` is not written to the signed identity schema.
   * @throws when the identity's root did not sign it.
   * @throws when the identity follows a signed identity of another root, or
   *   one that is not earlier.
   */
  async verify(object: EncodedObject<Json, SignedIdentityData>, reader: Reader): Promise<SignedIdentityObject> {
    if (object.schema.link !== this.schema.link) throw new Error(`a signed identity is written to ${this.schema.link}`);
    const identity = await readObject(reader, object.data.identity.$link, this.#identities.schema);
    const prior = identity.data.prior === undefined ? undefined : await this.read(identity.data.prior.$link, reader);
    return signedIdentityOf(object, await this.#identities.read(identity, prior, reader));
  }

  /** Reads the signed identity that `link` names from `reader`, and verifies it. */
  async read(link: Link<SignedIdentityObject>, reader: Reader): Promise<SignedIdentityObject> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  /**
   * Has `root` sign `identity`, giving the signed identity. The identity is
   * written before its root is asked to sign, so a root is not asked to sign
   * an identity that would not read.
   */
  async sign(root: Signer, identity: IdentityObject): Promise<SignedIdentityObject> {
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: { $link: identity.link }, signature: bytesToHex(signature) };
    return signedIdentityOf(encodeObject(this.schema, data), identity);
  }
}

function signedIdentityOf(
  object: EncodedObject<Json, SignedIdentityData>,
  identity: IdentityObject,
): SignedIdentityObject {
  const signature = hexToBytes(object.data.signature);
  if (!verify(identity.root, digestOf(identity.link), signature)) {
    throw new Error(`the root of ${identity.link} did not sign ${object.link}`);
  }
  return {
    ...object,
    link: object.link as Link<SignedIdentityObject>,
    identity,
    signature,
    blobs: [object.bytes, ...object.schema.blobs, ...identity.blobs],
  };
}
