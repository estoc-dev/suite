import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ed25519Curve } from "./curves.ts";
import { keySchema, type Scheme } from "./interface.ts";

const SIGNING_DOMAIN = concatBytes(Uint8Array.of(0xff), utf8ToBytes("solana offchain"));

/**
 * Signs a Solana off-chain message, version 1, naming the key as its one
 * signer, which Ledger's Solana app signs from 1.14.
 */
export const solanaOffchain: Scheme = {
  name: "solana-offchain",
  curve: ed25519Curve,
  message: (text, publicKey) => concatBytes(SIGNING_DOMAIN, Uint8Array.of(1, 1), publicKey, utf8ToBytes(text)),
  keySchema: keySchema("Solana off-chain key", ed25519Curve),
};
