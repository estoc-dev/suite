import type { KeyObject } from "./key/interface.ts";
import type { Signature } from "./signature.ts";
import type { SignedIdentityObject, Versions } from "./signed-identity.ts";

/**
 * Someone who signs, as a reader has seen them: a root, and the versions of
 * its identity the reader has seen, with the one in hand when the person was
 * asked for. Anyone who signs is a person by their root, a wallet as much as a
 * device or a service. A person is worked out from what the reader has seen
 * and is not written: their root names them, but what they hold changes as
 * more is seen.
 */
export interface Person {
  readonly root: KeyObject;
  /**
   * The versions of the root's identity the reader has seen, each signed by
   * the root, in the order of their `at` and then of their links. One the
   * root signed between two of them may be missing.
   */
  versions(): Promise<readonly SignedIdentityObject[]>;
  /**
   * The last of `versions`, which says who signs for the person now. It is
   * the latest the reader has seen, not the latest the root signed.
   */
  current(): Promise<SignedIdentityObject>;
  /** Whether `signature` was made for an identity of this person's root. */
  hasSigned(signature: Signature): boolean;
}

/**
 * The people of the versions a reader has seen. They are `Versions` too: the
 * current version of a signed identity is its person's.
 */
export interface People extends Versions {
  /** The person whose root signed `signedIdentity`, which counts among their versions. */
  personOf(signedIdentity: SignedIdentityObject): Person;
}
