import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type CurveScheme, curveScheme, secp256k1Curve } from "./curves.ts";

/** Signs an Ethereum `personal_sign` message. */
export const eip191: CurveScheme = curveScheme("eip191", secp256k1Curve, (text) => {
  const body = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak_256(concatBytes(prefix, body));
});
