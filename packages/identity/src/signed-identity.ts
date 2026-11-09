import {
  DRAFT_2020_12,
  digestOf,
  type EncodedObject,
  encodeObject,
  Implementations,
  type Json,
  type JsonLink,
  type JsonSchema,
  json,
  type Link,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { hexSchema } from "./hex.ts";
import type { IdentityImplementation, IdentityObject } from "./identity/interface.ts";
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
 * - `signature` holds the root's signature over the identity's link,
 *   whichever identity schema it is written to.
 * - What the root publishes is this object as it is, so a signature names
 *   the identity it is made for by the link of this object.
 * - Two signers are the same someone when the roots of their identities are
 *   the same, whichever signed identities they sign by.
 * - `blobs` are what it takes to read it again: the bytes of its object, the
 *   blobs of its schema, and the identity's `blobs`.
 */
export interface SignedIdentityObject<I extends IdentityObject = IdentityObject>
  extends EncodedObject<Json, SignedIdentityData> {
  readonly link: Link<SignedIdentityObject>;
  readonly identity: I;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/** Which signed identity of a root is current, of the identity versions a reader has seen. */
export interface SeenIdentityVersions {
  /**
   * The current identity version of `signedIdentity`'s root among those the
   * reader has seen, `signedIdentity` itself when none is later.
   */
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
}

/**
 * A reader that has seen no identity versions, so a signature is verified by
 * the identity version it carries alone.
 */
export const noIdentityVersions: SeenIdentityVersions = { current: async (signedIdentity) => signedIdentity };

/** Signed identities, with the identity schemas their identities are read with. */
export class SignedIdentities {
  readonly schema: Schema<Json, SignedIdentityData>;
  readonly #identities: Implementations<Json, IdentityObject, IdentityImplementation>;

  constructor(schema: Schema<Json, SignedIdentityData>, identities: Iterable<IdentityImplementation>) {
    this.schema = schema;
    this.#identities = new Implementations(json, identities);
  }

  /**
   * Verifies `object`, giving it with its identity, written to any of the
   * identity schemas, and the keys it names, both read from `reader`. An
   * identity stands for someone only as its root signed it, which reading its
   * object and keys alone does not verify.
   *
   * @throws when `object` is not written to the signed identity schema.
   * @throws when the identity's root did not sign it.
   */
  async verify(object: EncodedObject<Json, SignedIdentityData>, reader: Reader): Promise<SignedIdentityObject> {
    if (object.schema.link !== this.schema.link) throw new Error(`a signed identity is written to ${this.schema.link}`);
    return signedIdentityOf(object, await this.#identities.read(object.data.identity.$link, reader));
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
  async sign<I extends IdentityObject>(root: Signer, identity: I): Promise<SignedIdentityObject<I>> {
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: { $link: identity.link }, signature: bytesToHex(signature) };
    return signedIdentityOf(encodeObject(this.schema, data), identity);
  }
}

function signedIdentityOf<I extends IdentityObject>(
  object: EncodedObject<Json, SignedIdentityData>,
  identity: I,
): SignedIdentityObject<I> {
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
