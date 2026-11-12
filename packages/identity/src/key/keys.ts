import {
  type EncodedObject,
  encodeObject,
  type Implementation,
  Implementations,
  type Link,
  type Reader,
} from "@estoc/object";
import { bytes, schema } from "@estoc/schema";
import type { Key, KeyData, KeyObject, Scheme } from "./interface.ts";

interface KeyImplementation extends Implementation<KeyObject, KeyData> {
  readonly scheme: Scheme;
  read(object: EncodedObject<KeyData>): KeyObject;
}

/**
 * Reads keys written to the schemas of the schemes it is given, and refuses
 * a key written to any other schema.
 *
 * - The schema of a scheme has the scheme's name as its title and takes a public key alone, so
 *   each key has one object and one link. Where two schemes take keys of one shape, as ed25519
 *   and solana-offchain do, the name is all that sets their schemas, and so one public key's
 *   objects in them, apart.
 * - A schema does not say how long its bytes are, so a public key of another length than its
 *   scheme's is refused here.
 */
export class Keys {
  readonly #implementations: Implementations<KeyObject, KeyImplementation>;
  readonly #byScheme: ReadonlyMap<Scheme, KeyImplementation>;

  /** @throws when two of `schemes` have one name. */
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
          return { ...object, link: object.link as Link<KeyObject>, scheme, publicKey };
        },
      }),
    );
    this.#implementations = new Implementations(implementations);
    this.#byScheme = new Map(implementations.map((implementation) => [implementation.scheme, implementation]));
  }

  verify(object: EncodedObject<KeyData>): KeyObject {
    return this.#implementations.implementationOf(object.schema.link).read(object);
  }

  /** Reads the key that `link` names from `reader`, with the schema of the scheme it is written to. */
  read(link: Link<KeyObject>, reader: Reader): Promise<KeyObject> {
    return this.#implementations.read(link, reader);
  }

  /** Writes a key as its object, to the schema of its scheme. */
  encode({ scheme, publicKey }: Key): KeyObject {
    const implementation = this.#byScheme.get(scheme);
    if (implementation === undefined) throw new Error(`the ${scheme.name} scheme is not one written here`);
    return implementation.read(encodeObject(implementation.schema, { publicKey }));
  }
}
