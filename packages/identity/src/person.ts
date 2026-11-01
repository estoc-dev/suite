import type { DelegatedIdentityObject } from "./identity/delegated.ts";
import type { KeyObject } from "./key/interface.ts";
import type { Signature } from "./signature.ts";
import type { SignedIdentityObject, Versions } from "./signed-identity.ts";

/**
 * Someone as a reader knows them: a root, and the versions of its Delegated
 * Identity that the reader has seen, with the one in hand when the person
 * was asked for. Anyone who signs is a person by their root, a wallet as
 * much as a device or a service. A person is worked out from what the
 * reader has seen and is not written: their root names them, but what they
 * hold changes as more is seen.
 */
export interface Person {
  readonly root: KeyObject;
  /**
   * The versions of the root's Delegated Identity the reader knows, each
   * signed by the root, in the order of their `at` and then of their links.
   * The reader knows those it has seen, so one the root signed between two
   * of them may be missing.
   */
  versions(): Promise<readonly SignedIdentityObject<DelegatedIdentityObject>[]>;
  /**
   * The last of `versions`, which says who signs for the person now, or the
   * signed identity in hand when there is none. It is the latest the reader
   * knows, not the latest the root signed.
   */
  current(): Promise<SignedIdentityObject>;
  /** Whether `signature` was made for an identity of this person's root. */
  signed(signature: Signature): boolean;
}

/**
 * The people a reader knows. They are the versions it knows too: the
 * current version of a Delegated Identity is its person's current one,
 * while an Identity is its own, as its root's signature through it counts
 * whatever the versions.
 */
export interface People extends Versions {
  /** The person whose root signed `signedIdentity`, which counts among their versions when it is one. */
  of(signedIdentity: SignedIdentityObject): Person;
}
