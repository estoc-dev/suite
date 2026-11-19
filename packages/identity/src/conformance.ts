import { equalBytes } from "@noble/curves/utils.js";
import { type Key, type Scheme, verify } from "./key/interface.ts";
import type { Signer } from "./signer.ts";

// Each pair differs in its last byte alone, so a scheme that signs only the
// start of the text, as a curve that signs a hash does when given the text
// itself, verifies a signature over one for the other.
const digest = new Uint8Array(32).fill(1);
const otherDigest = Uint8Array.of(...new Uint8Array(31).fill(1), 2);
const signedIdentity = new Uint8Array(32).fill(3);
const otherSignedIdentity = Uint8Array.of(...new Uint8Array(31).fill(3), 4);

export async function checkScheme(
  scheme: Scheme,
  signer: Signer,
  reencoded: (signature: Uint8Array) => Uint8Array,
): Promise<readonly string[]> {
  const key: Key = { scheme, publicKey: signer.key.publicKey };
  const alone = await signer.sign(digest);
  const byIdentity = await signer.sign(digest, signedIdentity);
  const twin = reencoded(alone);
  const rules: readonly (readonly [boolean, string])[] = [
    [verify(key, digest, alone), "a signature does not verify"],
    [verify(key, digest, byIdentity, signedIdentity), "a signature by a signed identity does not verify"],
    [!verify(key, otherDigest, alone), "a signature verifies for another digest"],
    [!verify(key, digest, byIdentity, otherSignedIdentity), "a signature verifies by another signed identity"],
    [!verify(key, digest, byIdentity), "a signature by a signed identity verifies by none"],
    [!verify(key, digest, alone, signedIdentity), "a signature by none verifies by a signed identity"],
    [!equalBytes(twin, alone), "the reencoded signature is the signature itself"],
    [!verify(key, digest, twin), "another encoding of a signature verifies"],
  ];
  return rules.filter(([isKept]) => !isKept).map(([, violation]) => violation);
}
