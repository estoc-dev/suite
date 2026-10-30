import { utf8ToBytes } from "@noble/hashes/utils.js";
import { ed25519Curve } from "./curves.ts";
import { keySchema, type Scheme } from "./interface.ts";

/** Signs the text itself, as a software key or a Solana wallet's plain `signMessage` signs it. */
export const ed25519: Scheme = {
  name: "ed25519",
  curve: ed25519Curve,
  message: (text) => utf8ToBytes(text),
  keySchema: keySchema("Ed25519 key", ed25519Curve),
};
