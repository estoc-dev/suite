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
import { type KeyObject, verify } from "./key/interface.ts";
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
 * `signedIdentitySchema`, read with the identity and verified, the bytes
 * being the root's signature over the identity's link, whichever identity
 * schema it is written to. What the root publishes is this object as it is,
 * so a signature names the identity it is made for by the link of this
 * object. Two signers are the same someone when the roots of their
 * identities are the same, whichever signed identities they sign by.
 *
 * `blobs` are what it takes to read it again: the bytes of its object, of
 * its schema and of the schema's root, and the identity's `blobs`.
 */
export interface SignedIdentityObject<I extends IdentityObject = IdentityObject>
  extends EncodedObject<Json, SignedIdentityData> {
  readonly link: Link<SignedIdentityObject>;
  readonly identity: I;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/** Which signed identity of a root is current, of the versions a reader has seen. */
export interface Versions {
  /**
   * The current version of `signedIdentity`'s identity among those the reader
   * has seen, `signedIdentity` itself when none is later.
   */
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
}

/** A reader that has seen no versions, so a signature is verified by the version it carries alone. */
export const noVersions: Versions = { current: async (signedIdentity) => signedIdentity };

/**
 * Signed identities, with the identity schemas their identities are read
 * with. A signature is made by a signed identity, so what a signature asks of
 * the schema of its identity is asked here.
 */
export class SignedIdentities {
  readonly schema: Schema<Json, SignedIdentityData>;
  readonly #identities: Implementations<Json, IdentityObject, IdentityImplementation>;

  constructor(schema: Schema<Json, SignedIdentityData>, identities: Iterable<IdentityImplementation>) {
    this.schema = schema;
    this.#identities = new Implementations(json, identities);
  }

  /**
   * Reads the signed identity that `link` names from `reader`, with its
   * identity, written to any of the identity schemas, and the keys it names.
   * An identity stands for someone only as its root signed it, which reading
   * its object and keys alone does not verify.
   *
   * @throws when the identity's root did not sign it.
   */
  async read(link: Link<SignedIdentityObject>, reader: Reader): Promise<SignedIdentityObject> {
    const object = await readObject(reader, link, this.schema);
    return signedIdentityOf(object, await this.#identities.read(object.data.identity.$link, reader));
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

  /** The key that signs for `signedIdentity`'s identity and made `signature` over `object` by it; undefined when none did. */
  verify(signedIdentity: SignedIdentityObject, object: Link<never>, signature: Uint8Array): KeyObject | undefined {
    const { identity } = signedIdentity;
    return this.#implementationOf(identity).verify(
      identity,
      digestOf(object),
      signature,
      digestOf(signedIdentity.link),
    );
  }

  /** How `signer` signs an object by `signedIdentity`; undefined when its key does not sign for its identity. */
  signingFunction(
    signedIdentity: SignedIdentityObject,
    signer: Signer,
  ): ((object: Link<unknown>) => Promise<Uint8Array>) | undefined {
    const { identity } = signedIdentity;
    const sign = this.#implementationOf(identity).signingFunction(identity, signer);
    if (sign === undefined) return undefined;
    const by = digestOf(signedIdentity.link);
    return (object) => sign(digestOf(object), by);
  }

  /** Whether `key` signs for `signedIdentity`'s identity. */
  hasSigner(signedIdentity: SignedIdentityObject, key: KeyObject): boolean {
    const { identity } = signedIdentity;
    return this.#implementationOf(identity).hasSigner(identity, key);
  }

  #implementationOf(identity: IdentityObject): IdentityImplementation {
    return this.#identities.implementationOf(identity.schema.link);
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
    blobs: [object.bytes, object.schema.bytes, object.schema.root.bytes, ...identity.blobs],
  };
}
