import { utf8ToBytes } from "@noble/hashes/utils.js";
import { type CurveScheme, curveScheme, ed25519Curve } from "./curves.ts";

/** Signs the text itself, as a software key or a Solana wallet's plain `signMessage` signs it. */
export const ed25519: CurveScheme = curveScheme("ed25519", ed25519Curve, (text) => utf8ToBytes(text));
