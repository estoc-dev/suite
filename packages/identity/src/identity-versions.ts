import { type Link, LinkValue, type Reader, SelectionBySchema } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import { hasSigner } from "./identity.ts";
import type { KeyObject } from "./key/interface.ts";
import type { People, Person } from "./person.ts";
import type { Signature } from "./signature.ts";
import type { SignedIdentities, SignedIdentityData, SignedIdentityObject } from "./signed-identity.ts";

/**
 * The schema of an identity version as a row of an index: its identifier,
 * its `at`, its signed identity, and the last crisis of its chain.
 *
 * - A root that signs one identity twice with a signer that signs with
 *   randomness makes two identity versions at one `at`, told apart by the
 *   links of their signed identities.
 * - `lastCrisis` is the signed identity of the latest crisis among it and
 *   those it follows, itself when it is one. A row has none when none of them
 *   is a crisis.
 */
export const identityVersionSchema = schema("Identity Version", {
  identifier: link<KeyObject>(),
  at: integer(),
  signedIdentity: link<SignedIdentityObject>(),
  lastCrisis: optional(link<SignedIdentityObject>()),
});

export type IdentityVersionData = DataOf<typeof identityVersionSchema>;

/** The fields that order the rows of identity versions: those of someone come together, in the order of their `at`. */
export type IdentityVersionOrder = readonly ["identifier", "at", "signedIdentity"];

/** The rows of an index of identity versions, as `people` reads them. */
export interface IdentityVersionRows {
  /** The rows of the identity versions of `identifier`. */
  range(prefix: readonly [identifier: LinkValue<KeyObject>]): AsyncIterable<{ readonly data: IdentityVersionData }>;
}

/**
 * When blobs came to the reader's devices, as `arrivalsView` of
 * `@estoc/store` says for the signed identity schema, by the marks of a
 * private store.
 */
export interface Arrivals {
  /** When the blob of `link` came, or `undefined` when nothing says when. */
  atOf(link: Link<unknown>): number | undefined | Promise<number | undefined>;
}

/** Identity versions, as the rows of an index that signed identities give, and as the people of those a reader has seen. */
export class IdentityVersions {
  /** The schema of the rows of an index of identity versions, for whoever makes the index. */
  readonly schema = identityVersionSchema;
  /** The fields to order that index by, for `people` to read its rows. */
  readonly order: IdentityVersionOrder = ["identifier", "at", "signedIdentity"];
  /**
   * The selection of signed identities, each read as
   * `SignedIdentities.implementation` reads it.
   *
   * Anyone can send a signed identity, so one whose identity does not read,
   * or whose root did not sign it, is refused. An index over the selection
   * fails on it, as `@estoc/store` has an index fail.
   *
   * @throws {AbsentBlob} from `read`, when the reader gives no blob for the
   *   record, or for one that verifying it reads. The error has the link of
   *   that blob.
   * @throws from `read`, what the reader throws.
   * @throws from `read`, where `decodeObject` throws for an object of the
   *   signed identity schema, and where `SignedIdentities.implementation`
   *   throws for it.
   */
  readonly selection: SelectionBySchema<SignedIdentityObject, SignedIdentityData>;
  readonly rows = (signedIdentity: SignedIdentityObject): readonly [IdentityVersionData] => [
    this.identityVersionOf(signedIdentity),
  ];
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
    const { schema, implementation } = signedIdentities;
    this.selection = new SelectionBySchema(schema, (object, reader) => implementation.read(object, reader));
  }

  identityVersionOf(signedIdentity: SignedIdentityObject): IdentityVersionData {
    const { identity, link } = signedIdentity;
    const lastCrisis = lastCrisisOf(signedIdentity);
    return {
      identifier: new LinkValue(identity.identifier),
      at: identity.data.at,
      signedIdentity: new LinkValue(link),
      ...(lastCrisis === undefined ? {} : { lastCrisis: new LinkValue(lastCrisis) }),
    };
  }

  /**
   * The people of the identity versions a store holds, from `rows`, the rows
   * of its index of those identity versions, each as `identityVersionOf`
   * gives it. An identity version a row names is read from `reader`.
   *
   * The rows hold those that each identity version follows, as an index over
   * the blobs of a store does: the store holds the closure of each, and a
   * signed identity whose closure it lacks does not read.
   */
  people(rows: IdentityVersionRows, reader: Reader): People {
    const read = (link: Link<SignedIdentityObject>) => this.#signedIdentities.read(link, reader);
    const versionsOf = async (signedIdentity: SignedIdentityObject) => {
      const inHand = new Map([...chainOf(signedIdentity)].map((each) => [each.link, each] as const));
      const seen = new Map([...inHand.values()].map((each) => [each.link, this.identityVersionOf(each)] as const));
      for await (const { data } of rows.range([new LinkValue(signedIdentity.identity.identifier)]))
        seen.set(data.signedIdentity.link, data);
      const signedIdentityOf = async (link: Link<SignedIdentityObject>) => inHand.get(link) ?? read(link);
      return {
        inHand,
        seen: [...seen.values()].sort(compareIdentityVersions),
        signedIdentityOf,
        currentAmong: (countingVersions: readonly Link<SignedIdentityObject>[]) =>
          // biome-ignore lint/style/noNonNullAssertion: the latest crisis counts, or the one in hand when none is a crisis
          signedIdentityOf(countingVersions.at(-1)!),
      };
    };
    const personOf = (signedIdentity: SignedIdentityObject): Person => {
      const { identifier } = signedIdentity.identity;
      return {
        identifier,
        identityVersions: async () => {
          const { seen, signedIdentityOf } = await versionsOf(signedIdentity);
          return Promise.all(countingVersionsAmong(seen).map(signedIdentityOf));
        },
        current: async () => {
          const { seen, currentAmong } = await versionsOf(signedIdentity);
          return currentAmong(countingVersionsAmong(seen));
        },
        hasSigned: (signature) => signature.signedIdentity.identity.identifier === identifier,
      };
    };
    const honors = async (signature: Signature, arrivals?: Arrivals) => {
      const { signedIdentity, key } = signature;
      const { inHand, seen, currentAmong } = await versionsOf(signedIdentity);
      const countingVersions = countingVersionsAmong(seen);
      let countingVersionsThen = countingVersions;
      const at = await arrivals?.atOf(signature.link);
      if (arrivals !== undefined && at !== undefined) {
        const heldThen: IdentityVersionData[] = [];
        for (const row of seen) {
          const { link } = row.signedIdentity;
          const heldSince = inHand.has(link) ? undefined : await arrivals.atOf(link);
          if (heldSince === undefined || heldSince <= at) heldThen.push(row);
        }
        countingVersionsThen = countingVersionsAmong(heldThen);
      }
      return (
        countingVersions.includes(signedIdentity.link) &&
        hasSigner((await currentAmong(countingVersionsThen)).identity, key)
      );
    };
    return {
      personOf,
      current: (signedIdentity) => personOf(signedIdentity).current(),
      honors: (signature) => honors(signature),
      asOfArrival: (arrivals) => ({ honors: (signature) => honors(signature, arrivals) }),
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
 * The links of the identity versions of `ordered`, rows of one identifier in
 * their order, that count: the latest crisis and those that follow it, or
 * all of them when none is a crisis. Those that follow a crisis come after
 * it, so each crisis met starts them over.
 */
function countingVersionsAmong(ordered: readonly IdentityVersionData[]): Link<SignedIdentityObject>[] {
  let countingVersions: Link<SignedIdentityObject>[] = [];
  let cut: Link<SignedIdentityObject> | undefined;
  for (const { signedIdentity, lastCrisis } of ordered) {
    const link = signedIdentity.link;
    if (link === lastCrisis?.link) [cut, countingVersions] = [link, [link]];
    else if (lastCrisis?.link === cut) countingVersions.push(link);
  }
  return countingVersions;
}

function compareIdentityVersions(a: IdentityVersionData, b: IdentityVersionData): number {
  const [link, otherLink] = [a.signedIdentity.link, b.signedIdentity.link];
  return a.at !== b.at ? a.at - b.at : link < otherLink ? -1 : link > otherLink ? 1 : 0;
}
