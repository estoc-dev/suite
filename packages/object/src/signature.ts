import { type Signer, verify } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Identities, type IdentityData, type IdentityObject, identitySchema } from "./identity.ts";
import type { Json, JsonLink } from "./json.ts";
import { DRAFT_2020_12, HEX, type JsonSchema, type JsonSchemaValidator, linkSchema } from "./json-schema.ts";
import { digestOf, type Link } from "./link.ts";
import { type EncodedObject, encodeObject, type Reader, readObject } from "./object.ts";
import { encodeSchema, type Schema } from "./schema.ts";

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

export type SignatureData = {
  readonly identity: JsonLink<IdentityObject>;
  readonly object: JsonLink<never>;
  readonly signature: string;
};

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`: `{"$type": <link to signatureSchema>, "identity": <link
 * to the identity>, "object": <link to the object>, "signature": <hex>}`,
 * read and verified. That is all it says. Who has to sign, in what role and
 * by when are for the application that reads the object to decide. It names
 * the object by link, so it verifies without the object, but not without the
 * object of its identity. It travels apart from other signatures over the
 * same object. It does not say what the object is, so its link reads as any.
 */
export interface Signature extends EncodedObject<Json, SignatureData> {
  readonly link: Link<Signature>;
  readonly identity: IdentityObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
}

/** Signatures, verified and made with their schema and that of identities. */
export class Signatures {
  readonly schema: Schema<Json, SignatureData>;
  readonly identities: Identities;

  constructor(identity: Schema<Json, IdentityData>, signature: Schema<Json, SignatureData>) {
    this.identities = new Identities(identity);
    this.schema = signature;
  }

  /**
   * Gives a signature with its identity, and refuses it unless that identity
   * signed the object it names. The object of the identity is read from
   * `reader`. One identity can sign one object many times, since a wallet
   * need not sign deterministically, and each of those signatures verifies.
   */
  async verify(signature: EncodedObject<Json, SignatureData>, reader: Reader): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    const { data } = signature;
    const identity = await this.identities.read(data.identity.$link, reader);
    const object = data.object.$link;
    const value = hexToBytes(data.signature);
    if (!verify(identity, digestOf(object), value)) throw new Error(`the signature does not verify for ${object}`);
    return { ...signature, link: signature.link as Link<Signature>, identity, object, signature: value };
  }

  /** Reads the signature that `link` names from `reader`, and verifies it. */
  async read(link: Link<Signature>, reader: Reader): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  /**
   * Signs the link of an object, and so the object, whatever it is read as.
   * The signature names the signer's identity object, `signature.identity`,
   * whose bytes go along with it. A signature that does not verify is
   * refused.
   */
  async sign(object: { readonly link: Link<unknown> }, signer: Signer): Promise<Signature> {
    const identity = this.identities.encode(signer.identity);
    const signature = await signer.sign(digestOf(object.link));
    const data = { identity: { $link: identity.link }, object: { $link: object.link as Link<never> }, signature: bytesToHex(signature) };
    return this.verify(encodeObject(this.schema, data), new Map([[identity.link, identity.bytes]]));
  }
}

/** Signatures and the identities they name, with their schemas compiled by `validator`. */
export async function loadSignatures(validator: JsonSchemaValidator): Promise<Signatures> {
  return new Signatures(await encodeSchema(identitySchema, validator), await encodeSchema(signatureSchema, validator));
}
