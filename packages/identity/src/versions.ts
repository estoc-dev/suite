import type { Link, Reader } from "@estoc/object";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { SignedIdentities, SignedIdentityObject } from "./signed-identity.ts";

/**
 * A version of a root's identity, as a row: its root, its `at` and its
 * signed identity. Signing is taken to be deterministic, so a version has
 * one signed identity. The rows of a root's versions, in the order of their
 * keys, end with the current one.
 */
export type Version = readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>];

/** The versions of identities: the row each is, and the people a reader knows by those it has seen. */
export class IdentityVersions {
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
  }

  of(signedIdentity: SignedIdentityObject): Version {
    const { identity } = signedIdentity;
    return [identity.root.link, identity.data.at, signedIdentity.link];
  }

  /**
   * The people a reader knows, from `rows`, the rows of its index of the
   * versions it has seen, each as `of` gives it. A version a row names is
   * read from `reader`.
   */
  known(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<Version> }, reader: Reader): People {
    const read = (link: Link<SignedIdentityObject>) => this.#signedIdentities.read(link, reader);
    const order = (version: SignedIdentityObject, other: SignedIdentityObject) =>
      compare(this.of(version), this.of(other));
    const of = (signedIdentity: SignedIdentityObject): Person => {
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
          let last: Version | undefined;
          for await (const version of rows.range([root.link])) last = version;
          return last === undefined || compare(this.of(signedIdentity), last) >= 0 ? signedIdentity : read(last[2]);
        },
        signed: (signature) => signature.signedIdentity.identity.root.link === root.link,
      };
    };
    return { of, current: (signedIdentity) => of(signedIdentity).current() };
  }
}

// The order of the keys of rows of one root.
function compare([, at, link]: Version, [, otherAt, otherLink]: Version): number {
  return at !== otherAt ? at - otherAt : link < otherLink ? -1 : link > otherLink ? 1 : 0;
}
