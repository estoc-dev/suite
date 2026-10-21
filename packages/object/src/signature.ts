import { verify, type Signer } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { digestOf, encodeJson, HEX, isJsonObject, isLink, linkOf, type Bytes, type Link } from "./encoding.ts";
import { identities, type IdentityObject } from "./identity.ts";
import { DRAFT_2020_12, linkSchema, type JsonSchema, type Schema } from "./schema.ts";
import { View } from "./view.ts";

/**
 * The schema every signature is written to. Reading a signature checks its
 * fields in code and verifies it, so no validator compiles this schema for
 * that. It is for a reader that reads a signature as an object, such as a
 * viewer, which then reads its fields without verifying it.
 */
export const signatureSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Signature",
  type: "object",
  properties: {
    identity: linkSchema,
    object: linkSchema,
    signature: { type: "string", pattern: HEX.source },
  },
  required: ["identity", "object", "signature"],
  additionalProperties: false,
};

const SIGNATURE: Link<Schema> = linkOf(encodeJson(signatureSchema));

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`: `{"data": {"identity": <link to the identity>,
 * "object": <link to the object>, "signature": <hex>}, "schema": <link to
 * signatureSchema>}`. That is all it says. Who has to sign, in what role and
 * by when are for the application that reads the object to decide. It names
 * the object by link, so it verifies without the object, but not without the
 * object of its identity. It travels apart from other signatures over the
 * same object. It does not say what the object is, so its link reads as any.
 */
export interface Signature {
  readonly identity: IdentityObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
  readonly bytes: Bytes<Signature>;
  readonly link: Link<Signature>;
}

/**
 * Reads signatures, and refuses one unless its identity signed the object it
 * names. The identity is read from its object in the blobs given, through
 * `identities`. One identity can sign one object many times, since a wallet
 * need not sign deterministically, and each of those signatures reads.
 * `encode` writes a signature that has been made, and refuses one that does
 * not verify.
 */
export const signatures = new View<
  Signature,
  { readonly identity: IdentityObject; readonly object: Link<unknown>; readonly signature: Uint8Array }
>(
  [
    {
      schema: SIGNATURE,
      read(data, { bytes, link }, blobs) {
        if (!isJsonObject(data) || Object.keys(data).sort().join() !== "identity,object,signature") {
          throw new Error("a signature has the fields identity, object and signature");
        }
        const { identity: signer, object, signature: hex } = data;
        if (!isLink(signer)) throw new Error("a signature names its identity by link");
        if (!isLink(object)) throw new Error("a signature names its object by link");
        if (typeof hex !== "string" || !HEX.test(hex)) throw new Error("a signature is lowercase hex");
        const identity = identities.follow(signer, blobs);
        const signature = hexToBytes(hex);
        if (!verify(identity, digestOf(object), signature)) throw new Error(`the signature does not verify for ${object}`);
        return { identity, object, signature, bytes, link };
      },
    },
  ],
  {
    schema: SIGNATURE,
    write: ({ identity, object, signature }) => ({ identity: identity.link, object, signature: bytesToHex(signature) }),
  },
);

/**
 * Signs the link of an object, and so the object, whatever it is read as.
 * The signature names the signer's identity object, `signature.identity`,
 * whose bytes go along with it.
 */
export async function sign(object: { readonly link: Link<unknown> }, signer: Signer): Promise<Signature> {
  const identity = identities.encode(signer.identity);
  const signature = await signer.sign(digestOf(object.link));
  return signatures.encode({ identity, object: object.link, signature }, new Map([[identity.link, identity.bytes]]));
}
