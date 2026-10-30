export {
  type DelegatedIdentityData,
  type DelegatedIdentityObject,
  delegatedIdentitySchema,
  type Identities,
  type IdentityData,
  type IdentityObject,
  identitySchema,
  loadIdentities,
  type SignedIdentityData,
  type SignedIdentityObject,
  signedIdentitySchema,
} from "./identities.ts";
export { type Interface, identityInterface, keyInterface } from "./interfaces.ts";
export { type Key, sameKey, verify } from "./key.ts";
export { type KeyData, type KeyObject, type Keys, keySchemas, loadKeys } from "./keys.ts";
export type { Scheme } from "./scheme.ts";
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
