import { verify, type Identity, type Signer } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { identitySchema, identitySemantics, type IdentityObject } from "./identity.ts";
import type { Json, JsonLink } from "./json.ts";
import { DRAFT_2020_12, HEX, linkSchema, type JsonSchema, type JsonSchemaValidator } from "./json-schema.ts";
import { digestOf, type Bytes, type Link } from "./link.ts";
import { encodeSchema, type Schema } from "./schema.ts";
import { Semantics } from "./semantics.ts";

/**
 * The schema every signature is written to. A reader that reads a signature
 * as an object of this schema, such as a viewer, reads its fields without
 * verifying it.
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

type SignatureData = {
  readonly identity: JsonLink<IdentityObject>;
  readonly object: JsonLink<never>;
  readonly signature: string;
};

/**
 * Reads signatures, and refuses one unless its identity signed the object it
 * names. The identity is read from its object in the blobs given, through
 * `identities`. One identity can sign one object many times, since a wallet
 * need not sign deterministically, and each of those signatures reads.
 * `encode` writes a signature that has been made, and refuses one that does
 * not verify.
 */
export class Signatures extends Semantics<
  Json,
  Signature,
  { readonly identity: IdentityObject; readonly object: Link<unknown>; readonly signature: Uint8Array }
> {
  readonly identities: Semantics<IdentityObject, Identity>;

  constructor(identity: Schema<Json>, signature: Schema<Json>) {
    const identities = identitySemantics(identity);
    super(
      [
        {
          schema: signature,
          read(data, { bytes, link }, blobs) {
            const fields = data as SignatureData;
            const signer = identities.follow(fields.identity.$link, blobs);
            const object = fields.object.$link;
            const value = hexToBytes(fields.signature);
            if (!verify(signer, digestOf(object), value)) throw new Error(`the signature does not verify for ${object}`);
            return { identity: signer, object, signature: value, bytes, link };
          },
        },
      ],
      {
        schema: signature.link,
        write: ({ identity, object, signature }) => ({
          identity: { $link: identity.link },
          object: { $link: object },
          signature: bytesToHex(signature),
        }),
      },
    );
    this.identities = identities;
  }

  /**
   * Signs the link of an object, and so the object, whatever it is read as.
   * The signature names the signer's identity object, `signature.identity`,
   * whose bytes go along with it.
   */
  async sign(object: { readonly link: Link<unknown> }, signer: Signer): Promise<Signature> {
    const identity = this.identities.encode(signer.identity);
    const signature = await signer.sign(digestOf(object.link));
    return this.encode({ identity, object: object.link, signature }, new Map([[identity.link, identity.bytes]]));
  }
}

/** Signatures and the identities they name, read and written with their schemas compiled by `validator`. */
export async function loadSignatures(validator: JsonSchemaValidator): Promise<Signatures> {
  return new Signatures(await encodeSchema(identitySchema, validator), await encodeSchema(signatureSchema, validator));
}
