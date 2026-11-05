import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type CurveScheme, curveScheme, ed25519Curve } from "./curves.ts";

const SIGNING_DOMAIN = concatBytes(Uint8Array.of(0xff), utf8ToBytes("solana offchain"));

/**
 * Signs a Solana off-chain message, version 1, naming the key as its one
 * signer, which Ledger's Solana app signs from 1.14.
 */
export const solanaOffchain: CurveScheme = curveScheme("solana-offchain", ed25519Curve, (text, publicKey) =>
  concatBytes(SIGNING_DOMAIN, Uint8Array.of(1, 1), publicKey, utf8ToBytes(text)),
);
