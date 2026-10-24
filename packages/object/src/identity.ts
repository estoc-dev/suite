import { publicKeyLengths, type Identity, type Scheme } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Json } from "./json.ts";
import { DRAFT_2020_12, HEX, type JsonSchema } from "./json-schema.ts";
import type { Bytes, Link } from "./link.ts";
import type { Schema } from "./schema.ts";
import { Semantics } from "./semantics.ts";

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

/**
 * An identity of `@estoc/identity`, as an object written to `identitySchema`:
 * `{"$type": <link to identitySchema>, "publicKey": <lowercase hex>,
 * "scheme": <scheme>}`. A signature, or any object, names an identity by the
 * link of this object.
 */
export interface IdentityObject extends Identity {
  readonly bytes: Bytes<IdentityObject>;
  readonly link: Link<IdentityObject>;
}

/**
 * Reads identities, written to `schema`, in the schemes that
 * `@estoc/identity` knows, with the key at its scheme's length, so that each
 * identity has one object and one link. An identity in another scheme is
 * refused, though its object fits the schema. `encode` writes an identity as
 * its object.
 */
export function identitySemantics(schema: Schema<Json>): Semantics<IdentityObject, Identity> {
  return new Semantics(
    [
      {
        schema,
        read(data, { bytes, link }) {
          const { publicKey, scheme } = data as { readonly publicKey: string; readonly scheme: string };
          if (!Object.hasOwn(publicKeyLengths, scheme)) throw new Error(`unknown scheme ${scheme}`);
          const length = publicKeyLengths[scheme as Scheme];
          if (publicKey.length !== 2 * length) throw new Error(`a ${scheme} public key is ${length} bytes`);
          return { scheme: scheme as Scheme, publicKey: hexToBytes(publicKey), bytes, link };
        },
      },
    ],
    { schema: schema.link, write: ({ publicKey, scheme }) => ({ publicKey: bytesToHex(publicKey), scheme }) },
  );
}
