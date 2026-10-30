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
import type { Key } from "./key.ts";
import { type Scheme, schemes } from "./scheme.ts";

/**
 * The schema each scheme writes its keys to, holding the public key at the
 * scheme's length. A scheme added later comes with a schema of its own, so
 * keys already written keep their links.
 */
export const keySchemas: Readonly<Record<Scheme, JsonSchema>> = {
  ed25519: schemes.ed25519.keySchema,
  eip191: schemes.eip191.keySchema,
  "solana-offchain": schemes["solana-offchain"].keySchema,
};

export type KeyData = { readonly publicKey: string };

/**
 * A key read from its object, written to the key schema of its scheme. An
 * identity names its root by the link of this object.
 */
export interface KeyObject extends EncodedObject<Json, KeyData>, Key {
  readonly link: Link<KeyObject>;
}

/**
 * Reads keys written to the key schemas of the schemes this package knows,
 * and refuses a key written to any other schema. The schema a key is
 * written to is its scheme, so each key has one object and one link.
 */
export class Keys {
  readonly #schemas: Readonly<Record<Scheme, Schema<Json, KeyData>>>;
  readonly #schemes: ReadonlyMap<Link<Schema<Json>>, Scheme>;

  constructor(schemas: Readonly<Record<Scheme, Schema<Json, KeyData>>>) {
    this.#schemas = schemas;
    this.#schemes = new Map(Object.entries(schemas).map(([scheme, { link }]) => [link, scheme as Scheme]));
  }

  check(object: EncodedObject<Json, KeyData>): KeyObject {
    const scheme = this.#schemeOf(object.schema.link);
    return {
      ...object,
      link: object.link as Link<KeyObject>,
      scheme,
      publicKey: hexToBytes(object.data.publicKey),
    };
  }

  /** Reads the key that `link` names from `reader`, with the key schema it is written to, and checks it. */
  async read(link: Link<KeyObject>, reader: Reader): Promise<KeyObject> {
    const bytes = await reader.get(link);
    if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
    const object = decodeObject(bytes, this.#schemas[this.#schemeOf(schemaOf(bytes, json))]);
    if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
    return this.check(object);
  }

  /** Writes a key as its object, to the key schema of its scheme. */
  encode({ publicKey, scheme }: Key): KeyObject {
    return this.check(encodeObject(this.#schemas[scheme], { publicKey: bytesToHex(publicKey) }));
  }

  #schemeOf(schema: Link<Schema<Json>>): Scheme {
    const scheme = this.#schemes.get(schema);
    if (scheme === undefined) throw new Error(`no scheme writes its keys to ${schema}`);
    return scheme;
  }
}

/** Keys, with the key schemas compiled by `validator`. */
export async function loadKeys(validator: JsonSchemaValidator): Promise<Keys> {
  const compile = (scheme: Scheme) => encodeSchema<JsonSchema, Json, KeyData>(keySchemas[scheme], validator);
  return new Keys({
    ed25519: await compile("ed25519"),
    eip191: await compile("eip191"),
    "solana-offchain": await compile("solana-offchain"),
  });
}
