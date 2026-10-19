import { identityFromJson, identityToJson, verify, type Identity, type Signer } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeJson, digestOf, encodeJson, isJsonObject, isLink, type Link } from "./encoding.ts";
import type { EncodedObject } from "./object.ts";

/**
 * An identity standing behind an object, as one blob:
 * `{"identity": <identity>, "object": <link to the object>, "signature": <hex>}`.
 * That is all it says. Who has to sign, in what role and by when are for the
 * application that reads the object to decide. It names the object by link,
 * so it verifies without the object, and it travels on its own, apart from
 * other signatures over the same object.
 */
export interface Signature {
  readonly identity: Identity;
  readonly object: Link<EncodedObject>;
  readonly signature: Uint8Array;
  readonly bytes: Uint8Array;
  readonly link: Link<Signature>;
}

/**
 * Reads a signature, and refuses it unless its identity signed the object it
 * names. One identity can sign one object many times, since a wallet need not
 * sign deterministically, and each of those signatures reads.
 */
export function decodeSignature(bytes: Uint8Array): Signature {
  const decoded = decodeJson(bytes);
  const { value } = decoded;
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== "identity,object,signature") {
    throw new Error("a signature has the fields identity, object and signature");
  }
  const identity = identityFromJson(value.identity);
  const { object, signature: hex } = value;
  if (!isLink(object)) throw new Error("a signature names its object by link");
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("a signature is lowercase hex");
  const signature = hexToBytes(hex);
  if (!verify(identity, digestOf(object), signature)) throw new Error(`the signature does not verify for ${object}`);
  return { identity, object, signature, bytes: decoded.bytes, link: decoded.link };
}

export async function sign(object: EncodedObject, signer: Signer): Promise<Signature> {
  const { identity } = signer;
  const signature = await signer.sign(digestOf(object.link));
  return decodeSignature(
    encodeJson({ identity: identityToJson(identity), object: object.link, signature: bytesToHex(signature) }),
  );
}
