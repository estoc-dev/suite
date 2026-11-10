import type { KeyObject } from "./key/interface.ts";
import type { SeenIdentityVersions, Signature } from "./signature.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";

/**
 * Someone who signs, as a reader has seen them: a root, and its identity
 * versions that count by what the reader has seen and the one in hand when
 * the person was asked for. Anyone who signs is a person by their root, a
 * wallet as much as a device or a service. A person is worked out from what
 * the reader has seen and is not written: their root names them, but what
 * they hold changes as more is seen.
 */
export interface Person {
  readonly root: KeyObject;
  /**
   * The root's identity versions that count, each signed by the root, in the
   * order of their `at` and then of their links.
   *
   * - Of those the reader has seen and the one in hand with those it follows,
   *   they are the latest crisis and the ones that follow it, or all of them
   *   when none is a crisis.
   * - One the root signed later, or one that follows the same identity
   *   version as another, may be missing.
   */
  identityVersions(): Promise<readonly SignedIdentityObject[]>;
  /**
   * The last of `identityVersions`, which says who signs for the person now.
   * It is the latest that counts of those the reader has seen, not the
   * latest the root signed.
   */
  current(): Promise<SignedIdentityObject>;
  /** Whether `signature` was made for an identity of this person's root. */
  hasSigned(signature: Signature): boolean;
}

/** The people of the identity versions a reader has seen. */
export interface People extends SeenIdentityVersions {
  /** The person whose root signed `signedIdentity`, taken with it in hand. */
  personOf(signedIdentity: SignedIdentityObject): Person;
  /** The current identity version of the person of `signedIdentity`. */
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
}
