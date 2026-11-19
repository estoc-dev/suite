import type { Link } from "@estoc/object";
import type { Arrivals } from "./identity-versions.ts";
import type { SeenIdentityVersions, Signature } from "./signature.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";

export interface Person {
  readonly identifier: Link<unknown>;
  /**
   * Only those the reader has seen count, so one their root signed later, or one that follows the
   * same identity version as another, may be missing.
   */
  identityVersions(): Promise<readonly SignedIdentityObject[]>;
  /** The latest that counts of those the reader has seen, not the latest their root signed. */
  current(): Promise<SignedIdentityObject>;
  hasSigned(signature: Signature): boolean;
}

export interface People extends SeenIdentityVersions {
  personOf(signedIdentity: SignedIdentityObject): Person;
  current(signedIdentity: SignedIdentityObject): Promise<SignedIdentityObject>;
  /**
   * An identity version that `arrivals` give no time for counts as come before any signature. So a
   * program that publishes an identity version records it then, or signatures by the keys it takes
   * out stop being honored, those that had come before it as well.
   */
  asOfArrival(arrivals: Arrivals): SeenIdentityVersions;
}
