import type {
  IdentityKit,
  IdentityVersionData,
  IdentityVersionOrder,
  People,
  Person,
  SeenIdentityVersions,
  Signature,
} from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import { indexOver, selectedBlobs, type View } from "@estoc/store";

export interface StorePeople extends People {
  personIdentifiedBy(identifier: Link<unknown>): Promise<Person | undefined>;
}

export type PeopleView = View<IdentityVersionData, IdentityVersionOrder, StorePeople>;

/**
 * A store takes in identity versions from anyone it corresponds with. One that its root signed
 * gives a row whether or not a signature that carries it is honored.
 */
export function peopleView({
  identityVersions,
  signedIdentities,
}: Pick<IdentityKit, "identityVersions" | "signedIdentities">): PeopleView {
  return {
    index: indexOver(
      selectedBlobs(identityVersions.selection),
      identityVersions.schema,
      identityVersions.rows,
    ).orderedBy(...identityVersions.order),
    read: (rows, reader) => {
      const people = identityVersions.people(rows, reader);
      return {
        ...people,
        personIdentifiedBy: async (identifier) => {
          for await (const { data } of rows.range([new LinkValue(identifier)])) {
            return people.personOf(await signedIdentities.read(data.signedIdentity.link, reader));
          }
          return undefined;
        },
      };
    },
  };
}

export async function checkHonors(seenIdentityVersions: SeenIdentityVersions, signature: Signature): Promise<void> {
  if (await seenIdentityVersions.honors(signature)) return;
  const { key, signedIdentity } = signature;
  throw new Error(
    `the signature by ${key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
  );
}
