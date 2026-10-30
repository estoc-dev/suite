import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1Curve } from "./curves.ts";
import { keySchema, type Scheme } from "./interface.ts";

/** Signs an Ethereum `personal_sign` message. */
export const eip191: Scheme = {
  name: "eip191",
  curve: secp256k1Curve,
  message(text) {
    const body = utf8ToBytes(text);
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
    return keccak_256(concatBytes(prefix, body));
  },
  keySchema: keySchema("EIP-191 key", secp256k1Curve),
};
