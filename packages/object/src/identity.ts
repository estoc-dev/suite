import { publicKeyLengths, type Identity, type Scheme } from "@estoc/identity";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeJson, HEX, isJsonObject, linkOf, type Bytes, type Link } from "./encoding.ts";
import { DRAFT_2020_12, type JsonSchema, type Schema } from "./schema.ts";
import { View } from "./view.ts";

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

const IDENTITY: Link<Schema> = linkOf(encodeJson(identitySchema));

/**
 * An identity of `@estoc/identity`, as an object written to
 * `identitySchema`: `{"data": {"publicKey": <lowercase hex>, "scheme":
 * <scheme>}, "schema": <link to identitySchema>}`. A signature, or any
 * object, names an identity by the link of this object.
 */
export interface IdentityObject extends Identity {
  readonly bytes: Bytes<IdentityObject>;
  readonly link: Link<IdentityObject>;
}

/**
 * Reads identities in the schemes that `@estoc/identity` knows, with the key
 * in lowercase hex at its scheme's length, so that each identity has one
 * object and one link. An identity in another scheme is refused, though its
 * object fits the schema. `encode` writes an identity as its object.
 */
export const identities = new View<IdentityObject, Identity>(
  [
    {
      schema: IDENTITY,
      read(data, { bytes, link }) {
        if (!isJsonObject(data) || Object.keys(data).sort().join() !== "publicKey,scheme") {
          throw new Error("an identity has the fields publicKey and scheme");
        }
        const { publicKey, scheme } = data;
        if (typeof scheme !== "string" || !Object.hasOwn(publicKeyLengths, scheme)) throw new Error(`unknown scheme ${String(scheme)}`);
        const length = publicKeyLengths[scheme as Scheme];
        if (typeof publicKey !== "string" || publicKey.length !== 2 * length || !HEX.test(publicKey)) {
          throw new Error(`a ${scheme} public key is ${length} bytes in lowercase hex`);
        }
        return { scheme: scheme as Scheme, publicKey: hexToBytes(publicKey), bytes, link };
      },
    },
  ],
  { schema: IDENTITY, write: ({ publicKey, scheme }) => ({ publicKey: bytesToHex(publicKey), scheme }) },
);
