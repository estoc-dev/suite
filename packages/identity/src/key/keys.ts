import {
  type EncodedObject,
  encodeObject,
  type Implementation,
  Implementations,
  type Json,
  json,
  type Link,
  type Reader,
  type Schema,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Key, KeyData, KeyObject, Scheme } from "./interface.ts";

interface KeyImplementation extends Implementation<Json, KeyObject, KeyData> {
  readonly scheme: Scheme;
  read(object: EncodedObject<Json, KeyData>): KeyObject;
}

/**
 * Reads keys written to the key schemas of the schemes this package knows,
 * and refuses a key written to any other schema. The schema a key is
 * written to is its scheme, so each key has one object and one link.
 */
export class Keys {
  readonly #implementations: Implementations<Json, KeyObject, KeyImplementation>;
  readonly #ofScheme: ReadonlyMap<Scheme, KeyImplementation>;

  constructor(schemas: ReadonlyMap<Scheme, Schema<Json, KeyData>>) {
    const implementations = [...schemas].map(
      ([scheme, schema]): KeyImplementation => ({
        scheme,
        schema,
        read: (object) => ({
          ...object,
          link: object.link as Link<KeyObject>,
          scheme,
          publicKey: hexToBytes(object.data.publicKey),
        }),
      }),
    );
    this.#implementations = new Implementations(json, implementations);
    this.#ofScheme = new Map(implementations.map((implementation) => [implementation.scheme, implementation]));
  }

  check(object: EncodedObject<Json, KeyData>): KeyObject {
    return this.#implementations.of(object.schema.link).read(object);
  }

  /** Reads the key that `link` names from `reader`, with the key schema it is written to. */
  read(link: Link<KeyObject>, reader: Reader): Promise<KeyObject> {
    return this.#implementations.read(link, reader);
  }

  /** Writes a key as its object, to the key schema of its scheme. */
  encode({ scheme, publicKey }: Key): KeyObject {
    const implementation = this.#ofScheme.get(scheme);
    if (implementation === undefined) throw new Error(`the ${scheme.name} scheme is not one written here`);
    return implementation.read(encodeObject(implementation.schema, { publicKey: bytesToHex(publicKey) }));
  }
}
