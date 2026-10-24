import { publicKeyLengths, type Identity, type Scheme } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Json } from "./json.ts";
import { DRAFT_2020_12, HEX, type JsonSchema } from "./json-schema.ts";
import type { Link } from "./link.ts";
import { encodeObject, type EncodedObject } from "./object.ts";
import type { Schema } from "./schema.ts";

/**
 * The schema every identity is written to. It holds the shape of an
 * identity and no more: which schemes there are, and how long a key is in
 * each, is for whoever reads it, so an identity in a scheme added later is
 * written to this same schema.
 */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  type: "object",
  properties: {
    publicKey: { type: "string", pattern: HEX.source },
    scheme: { type: "string" },
  },
  required: ["publicKey", "scheme"],
  additionalProperties: false,
};

export type IdentityData = { readonly publicKey: string; readonly scheme: string };

/**
 * An identity of `@estoc/identity`, read from its object, written to
 * `identitySchema`: `{"$type": <link to identitySchema>, "publicKey":
 * <lowercase hex>, "scheme": <scheme>}`. A signature, or any object, names an
 * identity by the link of this object.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData>, Identity {
  readonly link: Link<IdentityObject>;
}

/**
 * Reads identities, in the schemes that `@estoc/identity` knows, with the key
 * at its scheme's length, so that each identity has one object and one link.
 * An identity in another scheme is refused, though its object fits the
 * schema.
 */
export class Identities {
  readonly schema: Schema<Json, IdentityData>;

  constructor(schema: Schema<Json, IdentityData>) {
    this.schema = schema;
  }

  read(object: EncodedObject<Json, IdentityData>): IdentityObject {
    if (object.schema.link !== this.schema.link) throw new Error(`an identity is written to ${this.schema.link}`);
    const { publicKey, scheme } = object.data;
    if (!Object.hasOwn(publicKeyLengths, scheme)) throw new Error(`unknown scheme ${scheme}`);
    const length = publicKeyLengths[scheme as Scheme];
    if (publicKey.length !== 2 * length) throw new Error(`a ${scheme} public key is ${length} bytes`);
    return { ...object, link: object.link as Link<IdentityObject>, scheme: scheme as Scheme, publicKey: hexToBytes(publicKey) };
  }

  /** Writes an identity as its object. */
  encode({ publicKey, scheme }: Identity): IdentityObject {
    return this.read(encodeObject(this.schema, { publicKey: bytesToHex(publicKey), scheme }));
  }
}
