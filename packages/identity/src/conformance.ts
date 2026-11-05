import { equalBytes } from "@noble/curves/utils.js";
import { type Key, type Scheme, verify } from "./key/interface.ts";
import type { Signer } from "./signer.ts";

const digest = new Uint8Array(32).fill(1);
const otherDigest = new Uint8Array(32).fill(2);
const signedIdentity = new Uint8Array(32).fill(3);
const otherSignedIdentity = new Uint8Array(32).fill(4);

/**
 * The rules for a scheme that `scheme` breaks, verifying what `signer`
 * signs, for a plugin to run in its tests; none when it keeps them.
 *
 * - What `signer` signs verifies, alone and by a signed identity.
 * - It does not verify for another digest, by another signed identity, by
 *   none in place of one, or by one in place of none.
 * - `reencoded` gives another encoding of a signature, one that a verifier
 *   that is not strict would take; what it gives does not verify.
 */
export async function violationsOf(
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
