import {
  digestOf,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  type Reader,
  readObject,
  type Value,
} from "@estoc/object";
import { bytes, type DataOf, link, schema } from "@estoc/schema";
import { blobsOf } from "./blobs.ts";
import type { Identities, IdentityObject } from "./identity.ts";
import { verify } from "./key/interface.ts";
import type { Signer } from "./signer.ts";

/** The schema every signed identity is written to, whatever the scheme of its root. */
export const signedIdentitySchema = schema("Signed Identity", {
  identity: link<IdentityObject>(),
  signature: bytes(),
});

export type SignedIdentityData = DataOf<typeof signedIdentitySchema>;

/**
 * An identity as its root publishes it: an object written to
 * `signedIdentitySchema`, read with the identity and verified.
 *
 * - `signature` holds the root's signature over the identity's link.
 * - What the root publishes is this object as it is, so a signature names
 *   the identity it is made for by the link of this object.
 * - Two signers are the same someone when the roots of their identities are
 *   the same, whichever signed identities they sign by.
 * - `blobs` are what it takes to read it again, each blob once: the bytes of
 *   its object, the closure of its schema, and the identity's `blobs`.
 */
export interface SignedIdentityObject extends EncodedObject<Value, SignedIdentityData> {
  readonly link: Link<SignedIdentityObject>;
  readonly identity: IdentityObject;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/** Signed identities, with the identities they sign. */
export class SignedIdentities {
  readonly schema = signedIdentitySchema;
  readonly #identities: Identities;

  constructor(identities: Identities) {
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
  async verify(object: EncodedObject<Value, SignedIdentityData>, reader: Reader): Promise<SignedIdentityObject> {
    if (object.schema.link !== this.schema.link) throw new Error(`a signed identity is written to ${this.schema.link}`);
    const identity = await readObject(reader, object.data.identity.link, this.#identities.schema);
    const prior = identity.data.prior === undefined ? undefined : await this.read(identity.data.prior.link, reader);
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
    const data = { identity: new LinkValue(identity.link), signature };
    return signedIdentityOf(encodeObject(this.schema, data), identity);
  }
}

function signedIdentityOf(
  object: EncodedObject<Value, SignedIdentityData>,
  identity: IdentityObject,
): SignedIdentityObject {
  const { signature } = object.data;
  if (!verify(identity.root, digestOf(identity.link), signature)) {
    throw new Error(`the root of ${identity.link} did not sign ${object.link}`);
  }
  return {
    ...object,
    link: object.link as Link<SignedIdentityObject>,
    identity,
    signature,
    blobs: blobsOf([object], identity.blobs),
  };
}
