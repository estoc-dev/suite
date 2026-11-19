import type { Signature, SignedIdentityObject } from "@estoc/identity";
import type { Link } from "@estoc/object";
import type { Arrivals } from "@estoc/store";

export interface SeenIdentityVersions {
  /**
   * A root signs a crisis when it no longer relies on what it signed before, so the signatures by
   * an identity version before it are not honored, the root's own among them. The one a signature
   * carries counts, as a device a wallet has just listed signs by an identity version the reader
   * has not seen yet.
   */
  honors(signature: Signature): Promise<boolean>;
}

/**
 * Goes by the identity versions the reader holds, and the one given to `personOf` with those it
 * follows, so one that their root signed later may be missing.
 */
export interface Person {
  readonly identifier: Link<unknown>;
  identityVersions(): Promise<readonly SignedIdentityObject[]>;
  current(): Promise<SignedIdentityObject>;
  hasSigned(signature: Signature): boolean;
}

export interface People extends SeenIdentityVersions {
  personOf(signedIdentity: SignedIdentityObject): Person;
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
  /** An identity version that `arrivals` give no time for counts as come before any signature. */
  asOfArrival(arrivals: Arrivals): SeenIdentityVersions;
}
