import { identityFromJson, identityToJson, verify, type Identity, type Signer } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { DRAFT_2020_12 } from "./builtins.ts";
import { digestOf, encodeJson, isJsonObject, isLink, linkOf, type Bytes, type Link } from "./encoding.ts";
import type { JsonSchema, Schema } from "./schema.ts";
import { View } from "./view.ts";

const HEX = /^(?:[0-9a-f]{2})*$/;

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
    identity: { $ref: "https://estoc.dev/schema/identity" },
    object: { $ref: "https://estoc.dev/schema/link" },
    signature: { type: "string", pattern: HEX.source },
  },
  required: ["identity", "object", "signature"],
  additionalProperties: false,
};

const SIGNATURE: Link<Schema> = linkOf(encodeJson(signatureSchema));

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`: `{"data": {"identity": <identity>, "object": <link to
 * the object>, "signature": <hex>}, "schema": <link to signatureSchema>}`.
 * That is all it says. Who has to sign, in what role and by when are for the
 * application that reads the object to decide. It names the object by link,
 * so it verifies without the object, and it travels on its own, apart from
 * other signatures over the same object. It does not say what the object is,
 * so its link reads as any.
 */
export interface Signature {
  readonly identity: Identity;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
  readonly bytes: Bytes<Signature>;
  readonly link: Link<Signature>;
}

/**
 * Reads signatures, and refuses one unless its identity signed the object it
 * names. One identity can sign one object many times, since a wallet need
 * not sign deterministically, and each of those signatures reads.
 */
export const signatures = new View<Signature>([
  {
    schema: SIGNATURE,
    read(data, { bytes, link }) {
      if (!isJsonObject(data) || Object.keys(data).sort().join() !== "identity,object,signature") {
        throw new Error("a signature has the fields identity, object and signature");
      }
      const identity = identityFromJson(data.identity);
      const { object, signature: hex } = data;
      if (!isLink(object)) throw new Error("a signature names its object by link");
      if (typeof hex !== "string" || !HEX.test(hex)) throw new Error("a signature is lowercase hex");
      const signature = hexToBytes(hex);
      if (!verify(identity, digestOf(object), signature)) throw new Error(`the signature does not verify for ${object}`);
      return { identity, object, signature, bytes, link };
    },
  },
]);

/** Signs the link of an object, and so the object, whatever it is read as. */
export async function sign(object: { readonly link: Link<unknown> }, signer: Signer): Promise<Signature> {
  const { identity } = signer;
  const signature = await signer.sign(digestOf(object.link));
  return signatures.encode(SIGNATURE, { identity: identityToJson(identity), object: object.link, signature: bytesToHex(signature) });
}
