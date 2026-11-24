import {
  type EncodedObject,
  encodeObject,
  type Implementation,
  Implementations,
  type Link,
  type Reader,
} from "@estoc/object";
import { bytes, schema } from "@estoc/schema";
import { distinctBlobsOf } from "../blobs.ts";
import type { Key, KeyData, KeyObject, Scheme } from "./interface.ts";

interface KeyImplementation extends Implementation<KeyObject, KeyData> {
  readonly scheme: Scheme;
  read(object: EncodedObject<KeyData>): KeyObject;
}

/**
 * Where two schemes take keys of one shape, as ed25519 and solana-offchain do, the title of each
 * scheme's schema, its name, is all that sets one public key's objects in them apart.
 */
export class Keys {
  readonly #implementations: Implementations<KeyObject, KeyImplementation>;
  readonly #byScheme: ReadonlyMap<Scheme, KeyImplementation>;
  readonly #schemesByName: ReadonlyMap<string, Scheme>;

  constructor(schemes: readonly Scheme[]) {
    const implementations = schemes.map(
      (scheme): KeyImplementation => ({
        scheme,
        schema: schema(scheme.name, { publicKey: bytes() }),
        read(object) {
          const { publicKey } = object.data;
          if (publicKey.length !== scheme.publicKeyLength)
            throw new Error(
              `a public key in ${scheme.name} is ${scheme.publicKeyLength} bytes, not ${publicKey.length}`,
            );
          return { link: object.link, scheme, publicKey, blobs: distinctBlobsOf(object) };
        },
      }),
    );
    this.#implementations = new Implementations(implementations);
    this.#byScheme = new Map(implementations.map((implementation) => [implementation.scheme, implementation]));
    this.#schemesByName = new Map(schemes.map((scheme) => [scheme.name, scheme]));
  }

  schemeNamed(name: string): Scheme | undefined {
    return this.#schemesByName.get(name);
  }

  verify(object: EncodedObject<KeyData>): KeyObject {
    const { link } = object.schema;
    const implementation = this.#implementations.implementationOf(link);
    if (implementation === undefined) throw new Error(`${link} is not a schema read here`);
    return implementation.read(object);
  }

  read(link: Link<unknown>, reader: Reader): Promise<KeyObject> {
    return this.#implementations.read(link, reader);
  }

  encode({ scheme, publicKey }: Key): KeyObject {
    const implementation = this.#byScheme.get(scheme);
    if (implementation === undefined) throw new Error(`the ${scheme.name} scheme is not one written here`);
    return implementation.read(encodeObject(implementation.schema, { publicKey }));
  }
}
