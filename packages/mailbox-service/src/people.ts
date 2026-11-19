import type { SeenIdentityVersions, Signature } from "@estoc/identity";

export async function checkHonors(seenIdentityVersions: SeenIdentityVersions, signature: Signature): Promise<void> {
  if (await seenIdentityVersions.honors(signature)) return;
  const { key, signedIdentity } = signature;
  throw new Error(
    `the signature by ${key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
  );
}
