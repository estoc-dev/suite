import type { Link, Reader } from "@estoc/object";
import type { DelegatedIdentities, DelegatedIdentityObject } from "./identity/delegated.ts";
import type { KeyObject } from "./key/interface.ts";
import type { SignedIdentities, SignedIdentityObject, Versions } from "./signed-identity.ts";

/**
 * A version of a root's Delegated Identity, as a row: its root, its `at` and
 * its signed identity. Signing is taken to be deterministic, so a version
 * has one signed identity. The rows of a root's versions, in the order of
 * their keys, end with the current one.
 */
export type Version = readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>];

/** The versions of Delegated Identities: the row each is, and the current one of a root among those a reader knows. */
export class DelegatedVersions {
  readonly #signedIdentities: SignedIdentities;
  readonly #delegatedIdentities: DelegatedIdentities;

  constructor(signedIdentities: SignedIdentities, delegatedIdentities: DelegatedIdentities) {
    this.#signedIdentities = signedIdentities;
    this.#delegatedIdentities = delegatedIdentities;
  }

  /** The version `signedIdentity` is; undefined for an identity of another schema, which has no versions. */
  of(signedIdentity: SignedIdentityObject): Version | undefined {
    if (!this.#isDelegated(signedIdentity)) return undefined;
    const { identity } = signedIdentity;
    return [identity.root.link, identity.data.at, signedIdentity.link];
  }

  /**
   * The versions a reader knows, from `rows`, the rows of its index of the
   * versions it has seen, each as `of` gives it. The current version of a
   * Delegated Identity is the later of the one given and the signed identity
   * of its root's last row, read from `reader`, and refused unless it is a
   * version of a Delegated Identity.
   */
  known(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<Version> }, reader: Reader): Versions {
    return {
      current: async (signedIdentity) => {
        if (!this.#isDelegated(signedIdentity)) return signedIdentity;
        let last: Version | undefined;
        for await (const version of rows.range([signedIdentity.identity.root.link])) last = version;
        if (last === undefined) return signedIdentity;
        const latest = await this.#signedIdentities.read(last[2], reader);
        if (!this.#isDelegated(latest)) throw new Error(`${latest.link} is not a version of a Delegated Identity`);
        return later(latest, signedIdentity) ? latest : signedIdentity;
      },
    };
  }

  #isDelegated(signedIdentity: SignedIdentityObject): signedIdentity is SignedIdentityObject<DelegatedIdentityObject> {
    return signedIdentity.identity.schema.link === this.#delegatedIdentities.schema.link;
  }
}

// In the order of the rows of their versions.
function later(
  version: SignedIdentityObject<DelegatedIdentityObject>,
  than: SignedIdentityObject<DelegatedIdentityObject>,
): boolean {
  const [at, thanAt] = [version.identity.data.at, than.identity.data.at];
  return at !== thanAt ? at > thanAt : version.link > than.link;
}
