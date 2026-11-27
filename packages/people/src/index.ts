import { identityKit, type Signature } from "@estoc/identity";
import { type Link, LinkValue } from "@estoc/object";
import type { View } from "@estoc/store";
import { type IdentityVersionData, identityVersions, peopleSeenIn } from "./identity-versions.ts";
import type { People, Person, SeenIdentityVersions } from "./person.ts";

export { type IdentityVersionData, identityVersions, identityVersionsOver } from "./identity-versions.ts";
export type { People, Person, SeenIdentityVersions } from "./person.ts";
export { type VerifiedSignatureData, verifiedSignaturesOf, verifiedSignaturesOver } from "./verified-signatures.ts";

export interface StorePeople extends People {
  personIdentifiedBy(identifier: Link<unknown>): Promise<Person | undefined>;
}

export const peopleView: View<IdentityVersionData, StorePeople> = {
  index: identityVersions,
  read: (rows, reader) => {
    const orderedRows = rows.orderedBy("identifier", "at", "signedIdentity");
    const people = peopleSeenIn(orderedRows, reader);
    return {
      ...people,
      personIdentifiedBy: async (identifier) => {
        for await (const { data } of orderedRows.range([new LinkValue(identifier)])) {
          return people.personOf(await identityKit.signedIdentities.read(data.signedIdentity.link, reader));
        }
        return undefined;
      },
    };
  },
};

export async function checkHonors(seenIdentityVersions: SeenIdentityVersions, signature: Signature): Promise<void> {
  if (await seenIdentityVersions.honors(signature)) return;
  const { key, signedIdentity } = signature;
  throw new Error(
    `the signature by ${key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
  );
}
