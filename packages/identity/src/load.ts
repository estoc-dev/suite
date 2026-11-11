import { encodeSchema, type Json, type Schema } from "@estoc/object";
import { Identities, type IdentityContent } from "./identity.ts";
import { IdentityVersions } from "./identity-versions.ts";
import type { KeyData, Scheme } from "./key/interface.ts";
import { Keys } from "./key/keys.ts";
import { type SchemeData, schemeValidator } from "./key/scheme.ts";
import { SecretKeys } from "./secret-key.ts";
import { Signatures } from "./signature.ts";
import { SignedIdentities, type SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";
import { WalletKeys } from "./wallet-key.ts";

/** What reads and writes the objects of each schema of this package, side by side. */
export interface IdentityKit {
  readonly keys: Keys;
  readonly identities: Identities;
  readonly signedIdentities: SignedIdentities;
  readonly signatures: Signatures;
  readonly identityVersions: IdentityVersions;
  readonly secretKeys: SecretKeys;
  readonly walletKeys: WalletKeys;
  /**
   * Writes the identity of `root`'s key that `content` says, and has `root`
   * sign it. Where an identity version signed by a clock that is off falls
   * among the others is for the root to answer for, as anything else it does
   * by that clock.
   */
  publish(root: Signer, content?: IdentityContent): Promise<SignedIdentityObject>;
}

/**
 * What reads and writes the objects of this package's schemas, with the
 * keys of `schemes`, each written to its scheme's object. The application
 * picks the schemes, so which keys it accepts is its own to say.
 *
 * @throws when the data of one of `schemes` does not fit the scheme schema,
 * or two of them have one object.
 */
export async function loadIdentity(schemes: readonly Scheme[]): Promise<IdentityKit> {
  const keySchemas = new Map<Scheme, Schema<Json, KeyData>>();
  for (const scheme of schemes) {
    const data = { name: scheme.name, publicKeyLength: scheme.publicKeyLength };
    keySchemas.set(scheme, await encodeSchema<Json, SchemeData, KeyData>(data, schemeValidator));
  }
  const keys = new Keys(keySchemas);
  const identities = new Identities(keys);
  const signedIdentities = new SignedIdentities(identities);
  return {
    keys,
    identities,
    signedIdentities,
    signatures: new Signatures(signedIdentities),
    identityVersions: new IdentityVersions(signedIdentities),
    secretKeys: new SecretKeys(keys),
    walletKeys: new WalletKeys(keys),
    publish: async (root, content) => signedIdentities.sign(root, identities.encode(root.key, content)),
  };
}
