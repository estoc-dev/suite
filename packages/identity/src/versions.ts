import type { Link, Reader } from "@estoc/object";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { SignedIdentities, SignedIdentityObject } from "./signed-identity.ts";

/**
 * A version of a root's identity, as a row: its root, its `at` and its
 * signed identity.
 *
 * - A root that signs one identity twice with a signer that signs with
 *   randomness makes two versions at one `at`, told apart by the links of
 *   their signed identities.
 * - The rows of a root's versions, in the order of their keys, `at` and then
 *   the link of the signed identity, end with the current one.
 */
export type IdentityVersion = readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>];

/** The versions of identities: the row each is, and the people of the versions a reader has seen. */
export class IdentityVersions {
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
  }

  versionOf(signedIdentity: SignedIdentityObject): IdentityVersion {
    const { identity } = signedIdentity;
    return [identity.root.link, identity.data.at, signedIdentity.link];
  }

  /**
   * The people of the versions a reader has seen, from `rows`, the rows of
   * its index of those versions, each as `versionOf` gives it. A version a
   * row names is read from `reader`.
   */
  people(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<IdentityVersion> }, reader: Reader): People {
    const read = (link: Link<SignedIdentityObject>) => this.#signedIdentities.read(link, reader);
    const order = (version: SignedIdentityObject, other: SignedIdentityObject) =>
      compareVersions(this.versionOf(version), this.versionOf(other));
    const personOf = (signedIdentity: SignedIdentityObject): Person => {
      const { root } = signedIdentity.identity;
      return {
        root,
        versions: async () => {
          const versions: SignedIdentityObject[] = [];
          for await (const [, , link] of rows.range([root.link])) versions.push(await read(link));
          if (!versions.some(({ link }) => link === signedIdentity.link)) versions.push(signedIdentity);
          return versions.sort(order);
        },
        current: async () => {
          let last: IdentityVersion | undefined;
          for await (const version of rows.range([root.link])) last = version;
          return last === undefined || compareVersions(this.versionOf(signedIdentity), last) >= 0
            ? signedIdentity
            : read(last[2]);
        },
        hasSigned: (signature) => signature.signedIdentity.identity.root.link === root.link,
      };
    };
    return { personOf, current: (signedIdentity) => personOf(signedIdentity).current() };
  }
}

function compareVersions([, at, link]: IdentityVersion, [, otherAt, otherLink]: IdentityVersion): number {
  return at !== otherAt ? at - otherAt : link < otherLink ? -1 : link > otherLink ? 1 : 0;
}
