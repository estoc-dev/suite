import { DRAFT_2020_12, type Json, type JsonSchema, type Schema, type SchemaValidator } from "@estoc/object";

/**
 * The schema each key scheme is an object of. The object of a scheme is the
 * schema its keys are written to, so every scheme's keys are written the
 * same way.
 *
 * - `name` names the scheme. Its object is a blob, so the name is part of its link and of the link
 *   of every key written to it. Where two schemes take keys of one shape, as ed25519 and
 *   solana-offchain do, the name is the only thing that sets their objects, and so one public
 *   key's objects in them, apart.
 * - `publicKeyLength` is how many bytes its public keys are.
 */
export const schemeSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Key Scheme",
  type: "object",
  properties: { name: { type: "string" }, publicKeyLength: { type: "integer", minimum: 1 } },
  required: ["name", "publicKeyLength"],
  additionalProperties: false,
};

export type SchemeData = { readonly name: string; readonly publicKeyLength: number };

/**
 * Key schemes as a language of schemas, whose schemas are the objects of
 * `schema`, the compiled `schemeSchema`. The object of a scheme takes a
 * key's public key alone, in lowercase hex at the scheme's length, so each
 * key has one object and one link; it checks a key without a JSON Schema
 * validator.
 */
export function schemeValidator(schema: Schema<Json, SchemeData>): SchemaValidator<Json, SchemeData> {
  return {
    language: {
      encoding: schema.encoding,
      link: schema.link,
      blobs: schema.blobs,
      data: (scheme) => scheme,
      document: (data) => schema.validate(data),
    },
    async compile({ publicKeyLength }) {
      const hex = new RegExp(`^[0-9a-f]{${2 * publicKeyLength}}$`);
      return ({ publicKey, ...rest }) => [
        ...(typeof publicKey === "string" && hex.test(publicKey)
          ? []
          : [`#/publicKey: not ${publicKeyLength} bytes in lowercase hex`]),
        ...Object.keys(rest).map((name) => `#/${name}: not a field of a key`),
      ];
    },
  };
}
