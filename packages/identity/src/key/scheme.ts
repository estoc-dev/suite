import type { Json, SchemaValidator } from "@estoc/object";
import { type DataOf, integer, schema, string } from "@estoc/schema";

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
export const schemeSchema = await schema("Key Scheme", { name: string(), publicKeyLength: integer() });

export type SchemeData = DataOf<typeof schemeSchema>;

/**
 * Key schemes as a language of schemas, whose schemas are the objects of
 * `schemeSchema`. The object of a scheme takes a key's public key alone, in
 * lowercase hex at the scheme's length, so each key has one object and one
 * link.
 */
export const schemeValidator: SchemaValidator<Json, SchemeData> = {
  language: {
    encoding: schemeSchema.encoding,
    link: schemeSchema.link,
    blobs: schemeSchema.blobs,
    data: (scheme) => scheme,
    document: (data) => schemeSchema.validate(data),
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
