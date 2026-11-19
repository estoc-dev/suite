import type { Link } from "@estoc/object";
import type { Arrivals } from "./identity-versions.ts";
import type { SeenIdentityVersions, Signature } from "./signature.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";

/**
 * Someone who signs, as a reader has seen them: an identifier, and their
 * identity versions that count by what the reader has seen and the one in
 * hand when the person was asked for. Anyone who signs is a person by their
 * identifier, a wallet as much as a device or a service. A person is worked
 * out from what the reader has seen and is not written: their identifier
 * names them, but what they hold changes as more is seen.
 */
export interface Person {
  readonly identifier: Link<unknown>;
  /**
   * The person's identity versions that count, each signed by its root, in
   * the order of their `at` and then of their links.
   *
   * - Of those the reader has seen and the one in hand with those it follows,
   *   they are the latest crisis and the ones that follow it, or all of them
   *   when none is a crisis.
   * - One their root signed later, or one that follows the same identity
   *   version as another, may be missing.
   */
  identityVersions(): Promise<readonly SignedIdentityObject[]>;
  /**
   * The last of `identityVersions`, which says who signs for the person now.
   * It is the latest that counts of those the reader has seen, not the
   * latest their root signed.
   */
  current(): Promise<SignedIdentityObject>;
  /** Whether `signature` was made for an identity of this person. */
  hasSigned(signature: Signature): boolean;
}

/**
 * The people of the identity versions a reader has seen.
 *
 * - Their `honors` takes a signature as one that comes in now, by all the
 *   identity versions the reader's store holds, as a service takes a request.
 * - `asOfArrival` takes a signature as of when it came to the reader's devices.
 */
export interface People extends SeenIdentityVersions {
  /** The person of `signedIdentity`, taken with it in hand. */
  personOf(signedIdentity: SignedIdentityObject): Person;
  /** The current identity version of the person of `signedIdentity`. */
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
  /**
   * What honors a signature as of when it came to the reader's devices, by
   * the times `arrivals` give.
   *
   * - The key that made it signs for the current identity version among
   *   those that had come by then, with the one it carries and those that
   *   one follows. An identity version that comes later and does not list
   *   the key leaves it honored.
   * - An identity version that came at the same time as the signature had
   *   come by then, and so had one that `arrivals` give no time for.
   * - The identity version it carries still counts by those the store holds
   *   now, so a crisis cuts it whenever the crisis came.
   * - A signature that `arrivals` give no time for comes in now, and is
   *   honored as by `honors`.
   */
  asOfArrival(arrivals: Arrivals): SeenIdentityVersions;
}
