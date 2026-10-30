import {
  DRAFT_2020_12,
  type EncodedObject,
  type Interface,
  interfaceNamed,
  type Json,
  type JsonSchema,
  type Link,
} from "@estoc/object";
import { equalBytes } from "@noble/curves/utils.js";
import { signingText } from "../signing-text.ts";

export const keyInterface: Interface = interfaceNamed("Key");

export interface Curve {
  readonly publicKeyLength: number;
  publicKeyOf(secretKey: Uint8Array): Uint8Array;
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  /** Takes a 64-byte signature and a key of `publicKeyLength` bytes. */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

/**
 * How a key signs: which curve, and how the signing text is wrapped before
 * the curve signs it, with the schema its keys are written to. A key kept in
 * a chain wallet signs only in that chain's off-chain message framing, so
 * the framing belongs to the key and a verifier never has to accept a
 * framing its holder did not choose.
 */
export interface Scheme {
  readonly name: string;
  readonly curve: Curve;
  message(text: string, publicKey: Uint8Array): Uint8Array;
  /** Written by `keySchema`, so that it names the Key interface. */
  readonly keySchema: JsonSchema;
}

// The schema is a blob, so its title is part of its link and of the link of
// every key written to it. Where two schemes take keys of one shape, as
// ed25519 and solana-offchain do, the title naming the scheme is the only
// thing that sets their schemas, and so one public key's objects in them,
// apart.
export function keySchema(title: string, curve: Curve): JsonSchema {
  return {
    $schema: DRAFT_2020_12,
    title,
    "x-implements": { $link: keyInterface.link },
    type: "object",
    properties: { publicKey: { type: "string", pattern: `^[0-9a-f]{${2 * curve.publicKeyLength}}$` } },
    required: ["publicKey"],
    additionalProperties: false,
  };
}

/**
 * A public key and the scheme it signs in. Two keys are the same when both
 * are; one public key under two schemes is two keys.
 *
 * Ed25519 keys are 32 bytes; secp256k1 keys are 33 bytes, compressed, so
 * that each key has one form to compare.
 */
export interface Key {
  readonly scheme: Scheme;
  readonly publicKey: Uint8Array;
}

export type KeyData = { readonly publicKey: string };

/**
 * A key read from its object, written to the key schema of its scheme. An
 * identity names its root by the link of this object.
 */
export interface KeyObject extends EncodedObject<Json, KeyData>, Key {
  readonly link: Link<KeyObject>;
}

/**
 * Whether `signature` is `key`'s signature over `signingText(digest,
 * signedIdentity)`. A key that is not a usable key in its scheme's form
 * verifies nothing.
 */
export function verify(key: Key, digest: Uint8Array, signature: Uint8Array, signedIdentity?: Uint8Array): boolean {
  const { scheme, publicKey } = key;
  return (
    publicKey.length === scheme.curve.publicKeyLength &&
    signature.length === 64 &&
    scheme.curve.verify(signature, scheme.message(signingText(digest, signedIdentity), publicKey), publicKey)
  );
}

/** Whether `a` and `b` are the same key: the same scheme, which is one value in a program, and the same bytes. */
export function sameKey(a: Key, b: Key): boolean {
  return a.scheme === b.scheme && equalBytes(a.publicKey, b.publicKey);
}
