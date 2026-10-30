import { encodeSchema, type Json, type JsonSchema, type JsonSchemaValidator, type Schema } from "@estoc/object";
import { DelegatedIdentities, type DelegatedIdentityObject, delegatedIdentitySchema } from "./identity/delegated.ts";
import { Identities, identitySchema } from "./identity/identity.ts";
import { ed25519 } from "./key/ed25519.ts";
import { eip191 } from "./key/eip191.ts";
import type { Key, KeyData, Scheme } from "./key/interface.ts";
import { Keys } from "./key/keys.ts";
import { solanaOffchain } from "./key/solana-offchain.ts";
import { Signatures, signatureSchema } from "./signature.ts";
import { SignedIdentities, type SignedIdentityObject, signedIdentitySchema } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";
import { DelegatedVersions } from "./versions.ts";

/** Each schema of this package, compiled, as what reads and writes its objects, side by side. */
export interface IdentityKit {
  readonly keys: Keys;
  readonly identities: Identities;
  readonly delegatedIdentities: DelegatedIdentities;
  readonly signedIdentities: SignedIdentities;
  readonly signatures: Signatures;
  readonly versions: DelegatedVersions;
  /** Writes the Identity whose root is `root`'s key, and has `root` sign it. */
  publish(root: Signer): Promise<SignedIdentityObject>;
  /**
   * Writes the Delegated Identity whose root is `root`'s key and whose
   * agents are `agents`, in that order, at `at`, and has `root` sign it.
   * Where a version signed by a clock that is off falls among the others is
   * for the root to answer for, as anything else it does by that clock.
   */
  delegate(root: Signer, agents: readonly Key[], at?: number): Promise<SignedIdentityObject<DelegatedIdentityObject>>;
}

/** The schemas of this package compiled by `validator`, with the keys of each scheme it knows. */
export async function loadIdentity(validator: JsonSchemaValidator): Promise<IdentityKit> {
  const schemes = new Map<Scheme, Schema<Json, KeyData>>();
  for (const scheme of [ed25519, eip191, solanaOffchain])
    schemes.set(scheme, await encodeSchema<JsonSchema, Json, KeyData>(scheme.keySchema, validator));
  const keys = new Keys(schemes);
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
    versions: new DelegatedVersions(signedIdentities, delegatedIdentities),
    publish: async (root) => signedIdentities.sign(root, identities.encode(root.key)),
    delegate: async (root, agents, at = Date.now()) =>
      signedIdentities.sign(root, delegatedIdentities.encode(root.key, agents, at)),
  };
}
