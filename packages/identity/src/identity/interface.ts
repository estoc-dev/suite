import {
  type EncodedObject,
  type Implementation,
  type Interface,
  interfaceNamed,
  type Json,
  type JsonLink,
  type Link,
} from "@estoc/object";
import { type KeyObject, keyInterface } from "../key/interface.ts";
import type { Signer } from "../signer.ts";

/** What the objects of each identity schema read as: an identity with its root. */
export const identityInterface: Interface = interfaceNamed("Identity");

export type IdentityData = { readonly root: JsonLink<KeyObject> };

/**
 * Someone who signs, as others see them: an identity read from its object
 * with its root, whichever identity schema the object is written to. It is
 * what every identity schema names as the Identity interface, and all a
 * reader that does not sign needs. Someone is their root: two identities are
 * of the same someone when the links of their roots are the same, and an
 * object that names someone names their root by that link, while a signature
 * names a signed identity of the identity it is made for. Which keys sign
 * for an identity, and how their signatures are laid out, is for its schema
 * to say.
 *
 * `blobs` are what it takes to read the identity again: the bytes of its
 * object and of the keys it names, and of the schemas they are written to,
 * each once. Reading does not need the interfaces those schemas name, but a
 * store takes in a blob only with all it leads to, so their bytes come along
 * as well.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly root: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

/** Signs the digest of an object by the digest of a signed identity, giving the bytes of a signature for its identity. */
export type Sign = (object: Uint8Array, signedIdentity: Uint8Array) => Promise<Uint8Array>;

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
  verify(identity: I, object: Uint8Array, signature: Uint8Array, signedIdentity: Uint8Array): KeyObject | undefined;
  /** How `signer` signs for `identity`; undefined when its key does not. */
  signing(identity: I, signer: Signer): Sign | undefined;
  /** Whether `key` signs for `identity`. */
  signs(identity: I, key: KeyObject): boolean;
}

/** The identity `object` is, whose root is `root` and which names `keys`. */
export function identityOf(
  object: EncodedObject<Json, IdentityData>,
  root: KeyObject,
  keys: readonly KeyObject[] = [root],
): IdentityObject {
  return { ...object, link: object.link as Link<IdentityObject>, root, blobs: blobsOf(object, keys) };
}

// A key can be both root and agent, and keys of one scheme share a schema,
// yet each blob is carried once.
function blobsOf(object: EncodedObject<Json>, keys: readonly KeyObject[]): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  const schemas = keys.map(({ schema }) => schema);
  for (const { link, bytes } of [object, ...keys, object.schema, ...schemas, identityInterface, keyInterface]) {
    blobs.set(link, bytes);
  }
  return [...blobs.values()];
}
