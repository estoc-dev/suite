import type { JsonSchema } from "@estoc/object";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { keyInterface } from "./interfaces.ts";

/**
 * How a key signs: which curve, and how the signing text is wrapped before
 * the curve signs it. A key kept in a chain wallet signs only in that
 * chain's off-chain message framing, so the framing belongs to the key and
 * a verifier never has to accept a framing its holder did not choose.
 *
 * - `ed25519`: the text itself, as a software key or a Solana wallet's plain
 *   `signMessage` signs it.
 * - `eip191`: an Ethereum `personal_sign` message.
 * - `solana-offchain`: a Solana off-chain message, version 1, naming this
 *   key as its one signer, which Ledger's Solana app signs from 1.14.
 */
export type Scheme = "ed25519" | "eip191" | "solana-offchain";

interface Curve {
  readonly publicKeyLength: number;
  publicKeyOf(secretKey: Uint8Array): Uint8Array;
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  /** Takes a 64-byte signature and a key of `publicKeyLength` bytes. */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

// Verification is strict so that one signing act has one valid encoding:
// signatures are stored and hashed as bytes, and a second encoding of the
// same signature would give the same act a second hash. Strict Ed25519 also
// refuses small-order keys, which admit signatures that verify for many
// messages, so their holder could later deny which one was signed.
const ed25519Curve: Curve = {
  publicKeyLength: 32,
  publicKeyOf: (secretKey) => ed25519.getPublicKey(secretKey),
  sign: (message, secretKey) => ed25519.sign(message, secretKey),
  verify: (signature, message, publicKey) => ed25519.verify(signature, message, publicKey, { zip215: false }),
};

// Signatures are compact `r || s` without the recovery byte: the public key
// is already known, and the byte would be one more thing to vary.
const secp256k1Curve: Curve = {
  publicKeyLength: 33,
  publicKeyOf: (secretKey) => secp256k1.getPublicKey(secretKey, true),
  sign: (message, secretKey) => secp256k1.sign(message, secretKey, { prehash: false }),
  verify: (signature, message, publicKey) =>
    secp256k1.verify(signature, message, publicKey, { prehash: false, lowS: true }),
};

const SOLANA_SIGNING_DOMAIN = concatBytes(Uint8Array.of(0xff), utf8ToBytes("solana offchain"));

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

// The schema is a blob, so its title is part of its link and of the link of
// every key written to it. Where two schemes take keys of one shape, as
// ed25519 and solana-offchain do, the title naming the scheme is the only
// thing that sets their schemas, and so one public key's objects in them,
// apart.
function keySchema(title: string, curve: Curve): JsonSchema {
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

interface Definition {
  readonly curve: Curve;
  message(text: string, publicKey: Uint8Array): Uint8Array;
  readonly keySchema: JsonSchema;
}

export const schemes: Readonly<Record<Scheme, Definition>> = {
  ed25519: {
    curve: ed25519Curve,
    message: (text) => utf8ToBytes(text),
    keySchema: keySchema("Ed25519 key", ed25519Curve),
  },
  eip191: {
    curve: secp256k1Curve,
    message(text) {
      const body = utf8ToBytes(text);
      const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
      return keccak_256(concatBytes(prefix, body));
    },
    keySchema: keySchema("EIP-191 key", secp256k1Curve),
  },
  "solana-offchain": {
    curve: ed25519Curve,
    message: (text, publicKey) => concatBytes(SOLANA_SIGNING_DOMAIN, Uint8Array.of(1, 1), publicKey, utf8ToBytes(text)),
    keySchema: keySchema("Solana off-chain key", ed25519Curve),
  },
};
