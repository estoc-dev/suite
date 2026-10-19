import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Identity } from "./identity.ts";
import { publicKeyLengths, type Scheme } from "./scheme.ts";

/**
 * An identity written as JSON: the key in lowercase hex, at its scheme's
 * length, so that each identity has one JSON form to sign and compare. It
 * is a type alias rather than an interface so that it fits a JSON value type.
 */
export type IdentityJson = {
  readonly publicKey: string;
  readonly scheme: Scheme;
};

export function identityToJson(identity: Identity): IdentityJson {
  return { publicKey: bytesToHex(identity.publicKey), scheme: identity.scheme };
}

/**
 * Reads an identity from its JSON form and refuses anything else. Whether
 * the key is a usable point is left to `verify`, as it is for any identity.
 */
export function identityFromJson(value: unknown): Identity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("an identity is a JSON object");
  }
  const fields = Object.keys(value).sort().join();
  if (fields !== "publicKey,scheme") {
    throw new Error(`an identity has the fields publicKey and scheme, got ${fields}`);
  }
  const { publicKey, scheme } = value as Record<string, unknown>;
  if (typeof scheme !== "string" || !Object.hasOwn(publicKeyLengths, scheme)) {
    throw new Error(`unknown scheme ${String(scheme)}`);
  }
  const length = publicKeyLengths[scheme as Scheme];
  if (typeof publicKey !== "string" || publicKey.length !== 2 * length || !/^[0-9a-f]*$/.test(publicKey)) {
    throw new Error(`a ${scheme} public key is ${length} bytes in lowercase hex`);
  }
  return { scheme: scheme as Scheme, publicKey: hexToBytes(publicKey) };
}
