import { type Json, type Link, type Reader, SelectionBySchema } from "@estoc/object";
import { hasSigner } from "./identity/interface.ts";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { SignedIdentities, SignedIdentityData, SignedIdentityObject } from "./signed-identity.ts";

/**
 * An identity version as a row: its root, its `at` and its signed identity.
 *
 * - A root that signs one identity twice with a signer that signs with
 *   randomness makes two identity versions at one `at`, told apart by the
 *   links of their signed identities.
 * - The rows of a root's identity versions, in the order of their keys, `at`
 *   and then the link of the signed identity, end with the current one.
 */
export type IdentityVersion = readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>];

/** Identity versions: the row each is, their selection, and the people of those a reader has seen. */
export class IdentityVersions {
  /**
   * The selection of signed identities, each read as the row
   * `identityVersionOf` gives.
   *
   * - Anyone can send a signed identity, so one whose identity does not read,
   *   or whose root did not sign it, gives `undefined`.
   * - A reader that throws or gives no blob for what the signed identity names
   *   leaves it out the same way, so what reads with a reader that can fail
   *   has to notice that itself.
   *
   * @throws from `read`, when the reader gives no blob for the record, and
   *   where `decodeObject` throws for an object of the signed identity schema.
   */
  readonly selection: SelectionBySchema<Json, IdentityVersion, SignedIdentityData>;
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
    this.selection = new SelectionBySchema(signedIdentities.schema, async (object, reader) => {
      try {
        return this.identityVersionOf(await signedIdentities.verify(object, reader));
      } catch {
        return undefined;
      }
    });
  }

  identityVersionOf(signedIdentity: SignedIdentityObject): IdentityVersion {
    const { identity } = signedIdentity;
    return [identity.root.link, identity.data.at, signedIdentity.link];
  }

  /**
   * The people of the identity versions a reader has seen, from `rows`, the
   * rows of its index of those identity versions, each as `identityVersionOf`
   * gives it. An identity version a row names is read from `reader`.
   */
  people(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<IdentityVersion> }, reader: Reader): People {
    const read = (link: Link<SignedIdentityObject>) => this.#signedIdentities.read(link, reader);
    const order = (signedIdentity: SignedIdentityObject, other: SignedIdentityObject) =>
      compareIdentityVersions(this.identityVersionOf(signedIdentity), this.identityVersionOf(other));
    const personOf = (signedIdentity: SignedIdentityObject): Person => {
      const { root } = signedIdentity.identity;
      return {
        root,
        identityVersions: async () => {
          const identityVersions: SignedIdentityObject[] = [];
          for await (const [, , link] of rows.range([root.link])) identityVersions.push(await read(link));
          if (!identityVersions.some(({ link }) => link === signedIdentity.link)) identityVersions.push(signedIdentity);
          return identityVersions.sort(order);
        },
        current: async () => {
          let last: IdentityVersion | undefined;
          for await (const identityVersion of rows.range([root.link])) last = identityVersion;
          return last === undefined || compareIdentityVersions(this.identityVersionOf(signedIdentity), last) >= 0
            ? signedIdentity
            : read(last[2]);
        },
        hasSigned: (signature) => signature.signedIdentity.identity.root.link === root.link,
      };
    };
    const current = (signedIdentity: SignedIdentityObject) => personOf(signedIdentity).current();
    return {
      personOf,
      current,
      counts: async ({ signedIdentity, key }) => hasSigner((await current(signedIdentity)).identity, key),
    };
  }
}

function compareIdentityVersions([, at, link]: IdentityVersion, [, otherAt, otherLink]: IdentityVersion): number {
  return at !== otherAt ? at - otherAt : link < otherLink ? -1 : link > otherLink ? 1 : 0;
}
