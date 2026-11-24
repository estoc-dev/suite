import { Identities, type IdentityContent } from "./identity.ts";
import { ed25519 } from "./key/ed25519.ts";
import { eip191 } from "./key/eip191.ts";
import type { Scheme } from "./key/interface.ts";
import { Keys } from "./key/keys.ts";
import { solanaOffchain } from "./key/solana-offchain.ts";
import { SecretKeys } from "./secret-key.ts";
import { Signatures } from "./signature.ts";
import { SignedIdentities, type SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";
import { WalletKeys } from "./wallet-key.ts";

export interface IdentityKit {
  readonly keys: Keys;
  readonly identities: Identities;
  readonly signedIdentities: SignedIdentities;
  readonly signatures: Signatures;
  readonly secretKeys: SecretKeys;
  readonly walletKeys: WalletKeys;
  publish(root: Signer, content?: IdentityContent): Promise<SignedIdentityObject>;
}

export function loadIdentity(schemes: readonly Scheme[]): IdentityKit {
  const keys = new Keys(schemes);
  const identities = new Identities(keys);
  const signedIdentities = new SignedIdentities(identities);
  return {
    keys,
    identities,
    signedIdentities,
    signatures: new Signatures(signedIdentities),
    secretKeys: new SecretKeys(keys),
    walletKeys: new WalletKeys(keys),
    publish: async (root, content) => signedIdentities.sign(root, identities.encode(root.key, content)),
  };
}

/**
 * The kit of the schemes the suite signs in. A program has this one alone, so what verifies with
 * it can be a constant as well.
 */
export const identityKit = loadIdentity([ed25519, eip191, solanaOffchain]);
