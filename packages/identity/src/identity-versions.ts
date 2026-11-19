import { type Link, LinkValue, type Reader, SelectionBySchema } from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import { hasSigner } from "./identity.ts";
import type { People, Person } from "./person.ts";
import type { Signature } from "./signature.ts";
import type { SignedIdentities, SignedIdentityData, SignedIdentityObject } from "./signed-identity.ts";

/**
 * A root that signs one identity twice with a signer that signs with randomness makes two identity
 * versions at one `at`, told apart by the links of their signed identities.
 */
export const identityVersionSchema = schema("Identity Version", {
  identifier: link(),
  at: integer(),
  signedIdentity: link(),
  lastCrisis: optional(link()),
});

export type IdentityVersionData = DataOf<typeof identityVersionSchema>;

export type IdentityVersionOrder = readonly ["identifier", "at", "signedIdentity"];

export interface IdentityVersionRows {
  range(prefix: readonly [identifier: LinkValue<unknown>]): AsyncIterable<{ readonly data: IdentityVersionData }>;
}

export interface Arrivals {
  atOf(link: Link<unknown>): number | undefined | Promise<number | undefined>;
}

export class IdentityVersions {
  readonly schema = identityVersionSchema;
  readonly order: IdentityVersionOrder = ["identifier", "at", "signedIdentity"];
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
      at: identity.at,
      signedIdentity: new LinkValue(link),
      ...(lastCrisis === undefined ? {} : { lastCrisis: new LinkValue(lastCrisis) }),
    };
  }

  /**
   * `rows` hold those that each identity version follows, as an index over the blobs of a store
   * does, since the store holds the closure of each.
   */
  people(rows: IdentityVersionRows, reader: Reader): People {
    const read = (link: Link<unknown>) => this.#signedIdentities.read(link, reader);
    const versionsOf = async (identifier: Link<unknown>, signedIdentity?: SignedIdentityObject) => {
      const inHand = new Map<Link<unknown>, SignedIdentityObject>(
        (signedIdentity === undefined ? [] : [...chainOf(signedIdentity)]).map((each) => [each.link, each] as const),
      );
      const seen = new Map<Link<unknown>, IdentityVersionData>(
        [...inHand.values()].map((each) => [each.link, this.identityVersionOf(each)] as const),
      );
      for await (const { data } of rows.range([new LinkValue(identifier)])) seen.set(data.signedIdentity.link, data);
      const signedIdentityOf = async (link: Link<unknown>) => inHand.get(link) ?? read(link);
      return {
        inHand,
        seen: [...seen.values()].sort(compareIdentityVersions),
        signedIdentityOf,
        currentAmong: (countingVersions: readonly Link<unknown>[]) =>
          // biome-ignore lint/style/noNonNullAssertion: the latest crisis counts, or the one in hand when none is a crisis
          signedIdentityOf(countingVersions.at(-1)!),
      };
    };
    const personIdentifiedBy = (identifier: Link<unknown>, signedIdentity?: SignedIdentityObject): Person => ({
      identifier,
      identityVersions: async () => {
        const { seen, signedIdentityOf } = await versionsOf(identifier, signedIdentity);
        return Promise.all(countingVersionsAmong(seen).map(signedIdentityOf));
      },
      current: async () => {
        const { seen, currentAmong } = await versionsOf(identifier, signedIdentity);
        return currentAmong(countingVersionsAmong(seen));
      },
      hasSigned: (signature) => signature.signedIdentity.identity.identifier === identifier,
    });
    const personOf = (signedIdentity: SignedIdentityObject) =>
      personIdentifiedBy(signedIdentity.identity.identifier, signedIdentity);
    const honors = async (signature: Signature, arrivals?: Arrivals) => {
      const { signedIdentity, key } = signature;
      const { inHand, seen, currentAmong } = await versionsOf(signedIdentity.identity.identifier, signedIdentity);
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
      personIdentifiedBy: async (identifier) =>
        (await versionsOf(identifier)).seen.length === 0 ? undefined : personIdentifiedBy(identifier),
      current: (signedIdentity) => personOf(signedIdentity).current(),
      honors: (signature) => honors(signature),
      asOfArrival: (arrivals) => ({ honors: (signature) => honors(signature, arrivals) }),
    };
  }
}

function* chainOf(signedIdentity: SignedIdentityObject): Iterable<SignedIdentityObject> {
  for (let each: SignedIdentityObject | undefined = signedIdentity; each !== undefined; each = each.identity.prior) {
    yield each;
  }
}

function lastCrisisOf(signedIdentity: SignedIdentityObject): Link<unknown> | undefined {
  for (const each of chainOf(signedIdentity)) if (each.identity.isCrisis) return each.link;
  return undefined;
}

function countingVersionsAmong(ordered: readonly IdentityVersionData[]): Link<unknown>[] {
  let countingVersions: Link<unknown>[] = [];
  let cut: Link<unknown> | undefined;
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
