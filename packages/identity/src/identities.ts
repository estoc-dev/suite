import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchema,
  type JsonSchemaValidator,
  json,
  type Link,
  type Reader,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Identity } from "./identity.ts";
import { type Scheme, schemes } from "./scheme.ts";

/**
 * The schema each scheme writes its identities to, holding the key at the
 * scheme's length. A scheme added later comes with a schema of its own, so
 * identities already written keep their links.
 */
export const identitySchemas: Readonly<Record<Scheme, JsonSchema>> = {
  ed25519: schemes.ed25519.identitySchema,
  eip191: schemes.eip191.identitySchema,
  "solana-offchain": schemes["solana-offchain"].identitySchema,
};

export type IdentityData = { readonly publicKey: string };

/**
 * An identity read from its object, written to the identity schema of its
 * scheme: `{"$describedBy": <link to that schema>, "publicKey": <lowercase
 * hex>}`. A signature, or any object, names an identity by the link of this
 * object.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData>, Identity {
  readonly link: Link<IdentityObject>;
}

/**
 * Reads identities written to the identity schemas of the schemes this
 * package knows, and refuses an identity written to any other schema. The
 * schema an identity is written to is its scheme, so each identity has one
 * object and one link.
 */
export class Identities {
  readonly #schemas: Readonly<Record<Scheme, Schema<Json, IdentityData>>>;
  readonly #schemes: ReadonlyMap<Link<Schema<Json>>, Scheme>;

  constructor(schemas: Readonly<Record<Scheme, Schema<Json, IdentityData>>>) {
    this.#schemas = schemas;
    this.#schemes = new Map(Object.entries(schemas).map(([scheme, { link }]) => [link, scheme as Scheme]));
  }

  check(object: EncodedObject<Json, IdentityData>): IdentityObject {
    const scheme = this.#schemeOf(object.schema.link);
    return {
      ...object,
      link: object.link as Link<IdentityObject>,
      scheme,
      publicKey: hexToBytes(object.data.publicKey),
    };
  }

  /**
   * Reads the identity that `link` names from `reader`, with the identity
   * schema it is written to, and checks it.
   */
  async read(link: Link<IdentityObject>, reader: Reader): Promise<IdentityObject> {
    const bytes = await reader.get(link);
    if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
    const object = decodeObject(bytes, this.#schemas[this.#schemeOf(schemaOf(bytes, json))]);
    if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
    return this.check(object);
  }

  /** Writes an identity as its object, to the identity schema of its scheme. */
  encode({ publicKey, scheme }: Identity): IdentityObject {
    return this.check(encodeObject(this.#schemas[scheme], { publicKey: bytesToHex(publicKey) }));
  }

  #schemeOf(schema: Link<Schema<Json>>): Scheme {
    const scheme = this.#schemes.get(schema);
    if (scheme === undefined) throw new Error(`no scheme writes its identities to ${schema}`);
    return scheme;
  }
}

/** Identities, with the identity schemas compiled by `validator`. */
export async function loadIdentities(validator: JsonSchemaValidator): Promise<Identities> {
  const compile = (scheme: Scheme) => encodeSchema<JsonSchema, Json, IdentityData>(identitySchemas[scheme], validator);
  return new Identities({
    ed25519: await compile("ed25519"),
    eip191: await compile("eip191"),
    "solana-offchain": await compile("solana-offchain"),
  });
}
