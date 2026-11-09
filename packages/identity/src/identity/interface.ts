import type { EncodedObject, Implementation, Json, JsonLink, Link } from "@estoc/object";
import { blobsOf } from "../blobs.ts";
import type { KeyObject } from "../key/interface.ts";
import type { Signer } from "../signer.ts";

export type IdentityData = { readonly root: JsonLink<KeyObject>; readonly at: number };

/**
 * Someone who signs, as others see them: an identity read from its object
 * with its root, whichever identity schema the object is written to.
 *
 * - It is what a program reads the objects of every identity schema as, and
 *   all a reader that does not sign needs.
 * - Someone is their root: two identities are of the same someone when the
 *   links of their roots are the same. An object that names someone names
 *   their root by that link, while a signature names a signed identity of
 *   the identity it is made for.
 * - Which keys sign for an identity, and how their signatures are laid out,
 *   is for its schema to say. It carries as `implementation` the
 *   implementation of its schema that read or wrote it, so what a signature
 *   asks of it is asked of the identity in hand.
 * - `at` is when the root signs it, in milliseconds since the Unix epoch by
 *   the root's clock. Each identity a root signs is an identity version,
 *   whatever schema it is written to.
 * - Of a root's identity versions the current one is that with the greatest
 *   `at`, and of those with the same `at`, that whose signed identity has the
 *   greater link. The current identity version says who signs for the root,
 *   the root itself included.
 * - `blobs` are the identity's closure, each blob once: the bytes of its
 *   object and of the keys it names, and the blobs of the schemas they are
 *   written to.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly root: KeyObject;
  readonly blobs: readonly Uint8Array[];
  readonly implementation: IdentityImplementation;
}

/** Signs the digest of an object by the digest of a signed identity, giving the bytes of a signature for its identity. */
export type SigningFunction = (object: Uint8Array, signedIdentity: Uint8Array) => Promise<Uint8Array>;

/**
 * One identity schema, as a program reads it as the Identity interface: how
 * its objects read, which of the keys each names sign for it, and how the
 * bytes of a signature for it are laid out. Signatures for any identity are
 * read and made the same way, so an identity schema added later is one more
 * of these.
 */
export interface IdentityImplementation<I extends IdentityObject = IdentityObject>
  extends Implementation<Json, I, I["data"]> {
  /**
   * The key that signs for `identity` and made `signature`, signing the
   * digest `object` by the digest `signedIdentity`; undefined when none did.
   */
  signerOf(identity: I, object: Uint8Array, signature: Uint8Array, signedIdentity: Uint8Array): KeyObject | undefined;
  /** How `signer` signs for `identity`; undefined when its key does not. */
  signingFunction(identity: I, signer: Signer): SigningFunction | undefined;
  /** Whether `key` signs for `identity`. */
  hasSigner(identity: I, key: KeyObject): boolean;
}

/** The key that signs for `identity` and made `signature`; undefined when none did. */
export function signerOf(
  identity: IdentityObject,
  object: Uint8Array,
  signature: Uint8Array,
  signedIdentity: Uint8Array,
): KeyObject | undefined {
  return identity.implementation.signerOf(identity, object, signature, signedIdentity);
}

/** How `signer` signs for `identity`; undefined when its key does not. */
export function signingFunction(identity: IdentityObject, signer: Signer): SigningFunction | undefined {
  return identity.implementation.signingFunction(identity, signer);
}

/** Whether `key` signs for `identity`. */
export function hasSigner(identity: IdentityObject, key: KeyObject): boolean {
  return identity.implementation.hasSigner(identity, key);
}

/** The identity `object` is, read or written with `implementation`, whose root is `root` and which names `keys`. */
export function identityOf(
  object: EncodedObject<Json, IdentityData>,
  implementation: IdentityImplementation,
  root: KeyObject,
  keys: readonly KeyObject[] = [root],
): IdentityObject {
  return {
    ...object,
    link: object.link as Link<IdentityObject>,
    root,
    blobs: blobsOf([object, ...keys]),
    implementation,
  };
}
