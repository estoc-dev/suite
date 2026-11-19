import type { Link } from "@estoc/object";
import type { Arrivals } from "./identity-versions.ts";
import type { SeenIdentityVersions, Signature } from "./signature.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";

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
