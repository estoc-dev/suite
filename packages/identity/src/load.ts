import { encodeSchema, type Json, type JsonSchemaValidator, type Schema } from "@estoc/object";
import { DelegatedIdentities, type DelegatedIdentityObject, delegatedIdentitySchema } from "./identity/delegated.ts";
import { Identities, identitySchema } from "./identity/identity.ts";
import { IdentityVersions } from "./identity-versions.ts";
import type { Key, KeyData, Scheme } from "./key/interface.ts";
import { Keys } from "./key/keys.ts";
import { type SchemeData, schemeSchema, schemeValidator } from "./key/scheme.ts";
import { SecretKeys, secretKeySchema } from "./secret-key.ts";
import { Signatures, signatureSchema } from "./signature.ts";
import { SignedIdentities, type SignedIdentityObject, signedIdentitySchema } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";
import { WalletKeys, walletKeySchema } from "./wallet-key.ts";

/** Each schema of this package, compiled, as what reads and writes its objects, side by side. */
export interface IdentityKit {
  readonly keys: Keys;
  readonly identities: Identities;
  readonly delegatedIdentities: DelegatedIdentities;
  readonly signedIdentities: SignedIdentities;
  readonly signatures: Signatures;
  readonly identityVersions: IdentityVersions;
  readonly secretKeys: SecretKeys;
  readonly walletKeys: WalletKeys;
  /**
   * Writes the Identity whose root is `root`'s key, at `at`, and has `root`
   * sign it. Where an identity version signed by a clock that is off falls
   * among the others is for the root to answer for, as anything else it does
   * by that clock.
   */
  publish(root: Signer, at?: number): Promise<SignedIdentityObject>;
  /**
   * Writes the Delegated Identity whose root is `root`'s key and whose
   * agents are `agents`, in that order, at `at`, and has `root` sign it, as
   * `publish` does.
   */
  delegate(root: Signer, agents: readonly Key[], at?: number): Promise<SignedIdentityObject<DelegatedIdentityObject>>;
}

/**
 * The schemas of this package compiled by `validator`, with the keys of
 * `schemes`, each written to its scheme's object. The application picks the
 * schemes, so which keys it accepts is its own to say.
 *
 * @throws when the data of one of `schemes` does not fit the scheme schema,
 * or two of them have one object.
 */
export async function loadIdentity(validator: JsonSchemaValidator, schemes: readonly Scheme[]): Promise<IdentityKit> {
  const keySchemaValidator = schemeValidator(await encodeSchema(schemeSchema, validator));
  const keySchemas = new Map<Scheme, Schema<Json, KeyData>>();
  for (const scheme of schemes) {
    const data = { name: scheme.name, publicKeyLength: scheme.publicKeyLength };
    keySchemas.set(scheme, await encodeSchema<Json, SchemeData, KeyData>(data, keySchemaValidator));
  }
  const keys = new Keys(keySchemas);
  const identities = new Identities(await encodeSchema(identitySchema, validator), keys);
  const delegatedIdentities = new DelegatedIdentities(await encodeSchema(delegatedIdentitySchema, validator), keys);
  const signedIdentities = new SignedIdentities(await encodeSchema(signedIdentitySchema, validator), [
    identities,
    delegatedIdentities,
  ]);
  return {
    keys,
    identities,
    delegatedIdentities,
    signedIdentities,
    signatures: new Signatures(await encodeSchema(signatureSchema, validator), signedIdentities),
    identityVersions: new IdentityVersions(signedIdentities),
    secretKeys: new SecretKeys(await encodeSchema(secretKeySchema, validator), keys),
    walletKeys: new WalletKeys(await encodeSchema(walletKeySchema, validator), keys),
    publish: async (root, at = Date.now()) => signedIdentities.sign(root, identities.encode(root.key, at)),
    delegate: async (root, agents, at = Date.now()) =>
      signedIdentities.sign(root, delegatedIdentities.encode(root.key, agents, at)),
  };
}
