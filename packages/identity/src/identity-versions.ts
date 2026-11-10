import { type Json, type Link, type Reader, SelectionBySchema } from "@estoc/object";
import { hasSigner } from "./identity.ts";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { SignedIdentities, SignedIdentityData, SignedIdentityObject } from "./signed-identity.ts";

/**
 * An identity version as a row: its root, its `at`, its signed identity, and
 * the last crisis of its chain.
 *
 * - A root that signs one identity twice with a signer that signs with
 *   randomness makes two identity versions at one `at`, told apart by the
 *   links of their signed identities.
 * - The rows of a root's identity versions are in the order of their keys,
 *   `at` and then the link of the signed identity.
 * - `lastCrisis` is the signed identity of the latest crisis among it and
 *   those it follows, itself when it is one. A row has none when none of them
 *   is a crisis.
 */
export type IdentityVersion =
  | readonly [root: Link<KeyObject>, at: number, signedIdentity: Link<SignedIdentityObject>]
  | readonly [
      root: Link<KeyObject>,
      at: number,
      signedIdentity: Link<SignedIdentityObject>,
      lastCrisis: Link<SignedIdentityObject>,
    ];

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
    const { identity, link } = signedIdentity;
    const lastCrisis = lastCrisisOf(signedIdentity);
    const row = [identity.root.link, identity.data.at, link] as const;
    return lastCrisis === undefined ? row : [...row, lastCrisis];
  }

  /**
   * The people of the identity versions a reader has seen, from `rows`, the
   * rows of its index of those identity versions, each as `identityVersionOf`
   * gives it. An identity version a row names is read from `reader`.
   *
   * The rows hold those that each identity version follows, as an index over
   * the blobs of a store does: the store holds the closure of each, and a
   * signed identity whose closure it lacks does not read.
   */
  people(rows: { range(prefix: readonly [Link<KeyObject>]): AsyncIterable<IdentityVersion> }, reader: Reader): People {
    const read = (link: Link<SignedIdentityObject>) => this.#signedIdentities.read(link, reader);
    const countingVersionsOf = async (signedIdentity: SignedIdentityObject) => {
      const inHand = new Map([...chainOf(signedIdentity)].map((each) => [each.link, each] as const));
      const seen = new Map([...inHand.values()].map((each) => [each.link, this.identityVersionOf(each)] as const));
      for await (const row of rows.range([signedIdentity.identity.root.link])) seen.set(row[2], row);
      const links = countingVersionsAmong([...seen.values()].sort(compareIdentityVersions)).map(([, , link]) => link);
      const signedIdentityOf = async (link: Link<SignedIdentityObject>) => inHand.get(link) ?? read(link);
      // biome-ignore lint/style/noNonNullAssertion: the latest crisis counts, or the one in hand when none is a crisis
      return { links, signedIdentityOf, current: () => signedIdentityOf(links[links.length - 1]!) };
    };
    const personOf = (signedIdentity: SignedIdentityObject): Person => {
      const { root } = signedIdentity.identity;
      return {
        root,
        identityVersions: async () => {
          const { links, signedIdentityOf } = await countingVersionsOf(signedIdentity);
          return Promise.all(links.map(signedIdentityOf));
        },
        current: async () => (await countingVersionsOf(signedIdentity)).current(),
        hasSigned: (signature) => signature.signedIdentity.identity.root.link === root.link,
      };
    };
    return {
      personOf,
      current: (signedIdentity) => personOf(signedIdentity).current(),
      counts: async ({ signedIdentity, key }) => {
        const { links, current } = await countingVersionsOf(signedIdentity);
        return links.includes(signedIdentity.link) && hasSigner((await current()).identity, key);
      },
    };
  }
}

/** `signedIdentity` and those it follows, from it back. */
function* chainOf(signedIdentity: SignedIdentityObject): Iterable<SignedIdentityObject> {
  for (let each: SignedIdentityObject | undefined = signedIdentity; each !== undefined; each = each.identity.prior) {
    yield each;
  }
}

/** The link of the latest crisis among `signedIdentity` and those it follows, as each is later than the one it follows. */
function lastCrisisOf(signedIdentity: SignedIdentityObject): Link<SignedIdentityObject> | undefined {
  for (const each of chainOf(signedIdentity)) if (each.identity.data.crisis) return each.link;
  return undefined;
}

/**
 * The rows of `ordered`, rows of one root in their order, whose identity
 * versions count: the latest crisis and those that follow it, or all of them
 * when none is a crisis. Those that follow a crisis come after it, so each
 * crisis met starts them over.
 */
function countingVersionsAmong(ordered: readonly IdentityVersion[]): IdentityVersion[] {
  let countingVersions: IdentityVersion[] = [];
  let cut: Link<SignedIdentityObject> | undefined;
  for (const row of ordered) {
    const [, , link, lastCrisis] = row;
    if (link === lastCrisis) [cut, countingVersions] = [link, [row]];
    else if (lastCrisis === cut) countingVersions.push(row);
  }
  return countingVersions;
}

function compareIdentityVersions([, at, link]: IdentityVersion, [, otherAt, otherLink]: IdentityVersion): number {
  return at !== otherAt ? at - otherAt : link < otherLink ? -1 : link > otherLink ? 1 : 0;
}
