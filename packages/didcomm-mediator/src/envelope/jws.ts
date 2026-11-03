import {
  base64url,
  fromBase64url,
  isObject,
  type JsonObject,
  optionalString,
  readEncodedObject,
  requiredString,
  utf8,
} from "./encoding.ts";
import { type OwnKey, type PublicKey, verifySignature } from "./keys.ts";

export const signedType = "application/didcomm-signed+json";

/** A JWS in the General JSON Serialization, as DIDComm writes a signed message. */
export interface Jws {
  readonly payload: string;
  readonly signatures: readonly {
    readonly protected: string;
    readonly header: { readonly kid: string };
    readonly signature: string;
  }[];
}

/** Signs `payload` with one key, whose kid goes in the unprotected header, as the spec's examples have it. */
export function sign(payload: Uint8Array, signer: OwnKey): Jws {
  const alg = signer.secret.algorithm;
  if (alg === undefined) throw new Error(`${signer.secret.curve} keys do not sign`);
  const protectedHeader = base64url(utf8(JSON.stringify({ typ: signedType, alg })));
  const encodedPayload = base64url(payload);
  const signature = signer.secret.sign(utf8(`${protectedHeader}.${encodedPayload}`));
  return {
    payload: encodedPayload,
    signatures: [{ protected: protectedHeader, header: { kid: signer.kid }, signature: base64url(signature) }],
  };
}

export interface Verified {
  readonly payload: Uint8Array;
  /** The kid of the key that signed. */
  readonly signer: string;
}

/**
 * Verifies a JWS of one signature, in the General or the Flattened JSON
 * Serialization. `signingKey` gives the key that `kid` names among the
 * signer's authentication keys; none refuses the JWS.
 */
export async function verify(
  jws: unknown,
  signingKey: (kid: string) => Promise<PublicKey | undefined>,
): Promise<Verified> {
  if (!isObject(jws)) throw new Error("the JWS is not an object");
  let entry: JsonObject;
  if (jws.signatures === undefined) {
    entry = jws;
  } else {
    // Only the sender's signature counts, so a second one would be another
    // claim nobody checks.
    if (!Array.isArray(jws.signatures) || jws.signatures.length !== 1) throw new Error("the JWS has not one signature");
    const [only] = jws.signatures;
    if (!isObject(only)) throw new Error("the JWS's signature is not an object");
    if (jws.signature !== undefined || jws.protected !== undefined) throw new Error("the JWS mixes serializations");
    entry = only;
  }
  const encodedPayload = requiredString(jws, "payload", "the JWS");
  const payload = fromBase64url(encodedPayload, "the JWS's payload");
  const protectedHeader = requiredString(entry, "protected", "the JWS");
  const header = readEncodedObject(protectedHeader, "the JWS's protected header");
  if (header.crit !== undefined) throw new Error("the JWS has critical extensions");
  const alg = requiredString(header, "alg", "the JWS's protected header");

  const unprotected = entry.header;
  if (unprotected !== undefined && !isObject(unprotected)) throw new Error("the JWS's header is not an object");
  const protectedKid = optionalString(header, "kid", "the JWS's protected header");
  const unprotectedKid = unprotected === undefined ? undefined : optionalString(unprotected, "kid", "the JWS's header");
  if (protectedKid !== undefined && unprotectedKid !== undefined && protectedKid !== unprotectedKid) {
    throw new Error("the JWS's headers name two keys");
  }
  const kid = protectedKid ?? unprotectedKid;
  if (kid === undefined) throw new Error("the JWS names no key");

  const key = await signingKey(kid);
  if (key === undefined) throw new Error(`${kid} is not an authentication key of its DID`);
  const signature = fromBase64url(entry.signature, "the JWS's signature");
  if (!verifySignature(alg, key, signature, utf8(`${protectedHeader}.${encodedPayload}`))) {
    throw new Error("the JWS's signature does not verify");
  }
  return { payload, signer: kid };
}
