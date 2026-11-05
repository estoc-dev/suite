export {
  type DelegatedIdentities,
  type DelegatedIdentityData,
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
} from "./identity/delegated.ts";
export { type Identities, identitySchema } from "./identity/identity.ts";
export { hasSigner, type IdentityData, type IdentityObject } from "./identity/interface.ts";
export { ed25519 } from "./key/ed25519.ts";
export { eip191 } from "./key/eip191.ts";
export {
  isSameKey,
  type Key,
  type KeyData,
  type KeyObject,
  type Scheme,
  verify,
} from "./key/interface.ts";
export type { Keys } from "./key/keys.ts";
export { type SchemeData, schemeSchema, schemeValidator } from "./key/scheme.ts";
export { solanaOffchain } from "./key/solana-offchain.ts";
export { type IdentityKit, loadIdentity } from "./load.ts";
export type { People, Person } from "./person.ts";
export {
  type Actor,
  type Signature,
  type SignatureData,
  type SignatureOver,
  type Signatures,
  signatureSchema,
} from "./signature.ts";
export {
  noVersions,
  type SignedIdentities,
  type SignedIdentityData,
  type SignedIdentityObject,
  signedIdentitySchema,
  type Versions,
} from "./signed-identity.ts";
export { type Signer, SoftwareSigner } from "./signer.ts";
export { signingText } from "./signing-text.ts";
export type { IdentityVersions, Version } from "./versions.ts";
