import type { Link, Reader } from "@estoc/object";
import type { DelegatedIdentities, DelegatedIdentityObject } from "./identity/delegated.ts";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { SignedIdentities, SignedIdentityObject } from "./signed-identity.ts";

/**
 * A version of a root's Delegated Identity, as a row: its root, its `at` and
 * its signed identity. Signing is taken to be deterministic, so a version
 * has one signed identity. The rows of a root's versions, in the order of
 * their keys, end with the current one.
 */
export type Version = readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>];

type Delegated = SignedIdentityObject<DelegatedIdentityObject>;

/** The versions of Delegated Identities: the row each is, and the people a reader knows by those it has seen. */
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
   * The people a reader knows, from `rows`, the rows of its index of the
   * versions it has seen, each as `of` gives it. A version a row names is
   * read from `reader`, and refused unless it is a version of a Delegated
   * Identity.
   */
  known(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<Version> }, reader: Reader): People {
    const read = async (link: Link<SignedIdentityObject>) => {
      const version = await this.#signedIdentities.read(link, reader);
      if (!this.#isDelegated(version)) throw new Error(`${version.link} is not a version of a Delegated Identity`);
      return version;
    };
    const of = (signedIdentity: SignedIdentityObject): Person => {
      const { root } = signedIdentity.identity;
      const given = this.#isDelegated(signedIdentity) ? signedIdentity : undefined;
      return {
        root,
        versions: async () => {
          const versions: Delegated[] = [];
          for await (const [, , link] of rows.range([root.link])) versions.push(await read(link));
          if (given !== undefined && !versions.some(({ link }) => link === given.link)) versions.push(given);
          return versions.sort(order);
        },
        current: async () => {
          let last: Version | undefined;
          for await (const version of rows.range([root.link])) last = version;
          if (last === undefined) return signedIdentity;
          const latest = await read(last[2]);
          return given !== undefined && order(given, latest) > 0 ? given : latest;
        },
        signed: (signature) => signature.signedIdentity.identity.root.link === root.link,
      };
    };
    return {
      of,
      current: async (signedIdentity) =>
        this.#isDelegated(signedIdentity) ? of(signedIdentity).current() : signedIdentity,
    };
  }

  #isDelegated(signedIdentity: SignedIdentityObject): signedIdentity is Delegated {
    return signedIdentity.identity.schema.link === this.#delegatedIdentities.schema.link;
  }
}

// The order of the rows of their versions.
function order(version: Delegated, other: Delegated): number {
  const [at, otherAt] = [version.identity.data.at, other.identity.data.at];
  return at !== otherAt ? at - otherAt : version.link < other.link ? -1 : version.link > other.link ? 1 : 0;
}
