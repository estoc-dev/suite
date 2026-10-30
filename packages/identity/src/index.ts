export {
  type DelegatedIdentityData,
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  type Identities,
  type IdentityData,
  type IdentityObject,
  identitySchema,
  loadIdentities,
  noVersions,
  type SignedIdentityData,
  type SignedIdentityObject,
  signedIdentitySchema,
  type Version,
  type Versions,
  versionOf,
} from "./identities.ts";
export { identityInterface } from "./interfaces.ts";
export { ed25519 } from "./key/ed25519.ts";
export { eip191 } from "./key/eip191.ts";
export { type Key, type KeyData, type KeyObject, keyInterface, type Scheme, sameKey, verify } from "./key/interface.ts";
export { type Keys, loadKeys } from "./key/keys.ts";
export { solanaOffchain } from "./key/solana-offchain.ts";
export {
  type Actor,
  loadSignatures,
  type Signature,
  type SignatureData,
  type Signatures,
  signatureSchema,
} from "./signatures.ts";
export { type Signer, SoftwareSigner } from "./signer.ts";
export { signingText } from "./signing-text.ts";
