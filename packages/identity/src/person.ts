import type { KeyObject } from "./key/interface.ts";
import type { Signature } from "./signature.ts";
import type { SignedIdentityObject, Versions } from "./signed-identity.ts";

/**
 * Someone as a reader knows them: a root, and the versions of its identity
 * that the reader has seen, with the one in hand when the person was asked
 * for. Anyone who signs is a person by their root, a wallet as much as a
 * device or a service. A person is worked out from what the reader has seen
 * and is not written: their root names them, but what they hold changes as
 * more is seen.
 */
export interface Person {
  readonly root: KeyObject;
  /**
   * The versions of the root's identity the reader knows, each signed by
   * the root, in the order of their `at` and then of their links. The reader
   * knows those it has seen, so one the root signed between two of them may
   * be missing.
   */
  versions(): Promise<readonly SignedIdentityObject[]>;
  /**
   * The last of `versions`, which says who signs for the person now. It is
   * the latest the reader knows, not the latest the root signed.
   */
  current(): Promise<SignedIdentityObject>;
  /** Whether `signature` was made for an identity of this person's root. */
  signed(signature: Signature): boolean;
}

/** The people a reader knows. They are the versions it knows too: the current version of a signed identity is its person's. */
export interface People extends Versions {
  /** The person whose root signed `signedIdentity`, which counts among their versions. */
  of(signedIdentity: SignedIdentityObject): Person;
}

/**
 * The people of a reader that knows no versions: each has the version in
 * hand alone, so a signature is judged by the version it carries.
 */
export const noVersions: People = {
  of: (signedIdentity) =>
    personOf(signedIdentity, { versions: async () => [signedIdentity], current: async () => signedIdentity }),
  current: async (signedIdentity) => signedIdentity,
};

/** The person of `signedIdentity`'s root, whose versions, with the one in hand, `known` gives. */
export function personOf(signedIdentity: SignedIdentityObject, known: Pick<Person, "versions" | "current">): Person {
  const { root } = signedIdentity.identity;
  return {
    root,
    versions: known.versions,
    current: known.current,
    signed: (signature) => signature.signedIdentity.identity.root.link === root.link,
  };
}
