import {
  digestOf,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonLink,
  type JsonSchema,
  type JsonSchemaValidator,
  type Link,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { hexSchema, type Identities, loadIdentities, rulesOf, type SignedIdentityObject } from "./identities.ts";
import type { KeyObject } from "./keys.ts";
import type { Signer } from "./signer.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * The schema every signature is written to, whatever the scheme of the key
 * that signs. A reader that reads a signature as an object of this schema,
 * such as a viewer, reads its fields without verifying it.
 *
 * `signature` holds bytes in hex, and the schema says no more of them. The
 * schema of the identity the signature is made for says which key signs and
 * how the bytes are laid out, and that key's scheme how its signature in them
 * reads. However they are laid out, they stay bytes, so this schema and those
 * who read signatures by it do not change for an identity schema or a scheme
 * added later.
 */
export const signatureSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Signature",
  type: "object",
  properties: {
    signedIdentity: linkSchema,
    object: linkSchema,
    signature: hexSchema,
  },
  required: ["signedIdentity", "object", "signature"],
  additionalProperties: false,
};

export type SignatureData = {
  readonly signedIdentity: JsonLink<SignedIdentityObject>;
  readonly object: JsonLink<never>;
  readonly signature: string;
};

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`: `{"$describedBy": <link to signatureSchema>,
 * "signedIdentity": <link to the signed identity>, "object": <link to the
 * object>, "signature": <hex>}`, read and verified, with `key`, the key that
 * signed for the identity. That is all it says.
 * Who has to sign, in what role and by when are for the application that
 * reads the object to decide. It names the object by link, so it verifies
 * without the object, but not without the blobs of its signed identity. It
 * travels apart from other signatures over the same object. It does not
 * say what the object is, so its link reads as any.
 */
export interface Signature extends EncodedObject<Json, SignatureData> {
  readonly link: Link<Signature>;
  readonly signedIdentity: SignedIdentityObject;
  readonly key: KeyObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
}

/**
 * A signer acting for an identity it signs for, as one signed identity of
 * it, which every signature it makes names.
 */
export interface Actor {
  readonly signedIdentity: SignedIdentityObject;
  /**
   * Signs the link of an object, and so the object, whatever it is read as.
   * The signature's `signedIdentity.blobs` go along with it. A signature that does
   * not verify is refused.
   */
  sign(object: { readonly link: Link<unknown> }): Promise<Signature>;
}

/** Signatures, verified and made with their schema and the identities they name. */
export class Signatures {
  readonly schema: Schema<Json, SignatureData>;
  readonly identities: Identities;

  constructor(identities: Identities, signature: Schema<Json, SignatureData>) {
    this.identities = identities;
    this.schema = signature;
  }

  /**
   * Gives a signature with its signed identity and the key that made it, and
   * refuses it unless a key that signs for that identity signed the object it
   * names by that signed identity. The signed identity, its identity and the
   * keys it names are read from `reader`. The identity's schema says which
   * key made the signature and how its bytes are laid out, and the key's
   * scheme how its signature is read.
   */
  async verify(signature: EncodedObject<Json, SignatureData>, reader: Reader): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    return signatureOf(signature, await this.identities.read(signature.data.signedIdentity.$link, reader));
  }

  /** Reads the signature that `link` names from `reader`, and verifies it. */
  async read(link: Link<Signature>, reader: Reader): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  /** An actor for `signedIdentity`, which refuses a signer whose key does not sign for its identity. */
  actor(signer: Signer, signedIdentity: SignedIdentityObject): Actor {
    const { identity } = signedIdentity;
    const sign = rulesOf(identity).signing(identity, signer);
    if (sign === undefined) throw new Error(`the signer's key does not sign for ${identity.link}`);
    const schema = this.schema;
    const by = digestOf(signedIdentity.link);
    return {
      signedIdentity,
      async sign(object) {
        const data = {
          signedIdentity: { $link: signedIdentity.link },
          object: { $link: object.link as Link<never> },
          signature: bytesToHex(await sign(digestOf(object.link), by)),
        };
        return signatureOf(encodeObject(schema, data), signedIdentity);
      },
    };
  }
}

function signatureOf(signature: EncodedObject<Json, SignatureData>, signedIdentity: SignedIdentityObject): Signature {
  const object = signature.data.object.$link;
  const value = hexToBytes(signature.data.signature);
  const { identity } = signedIdentity;
  const key = rulesOf(identity).verify(identity, digestOf(object), value, digestOf(signedIdentity.link));
  if (key === undefined) throw new Error(`the signature does not verify for ${object}`);
  return { ...signature, link: signature.link as Link<Signature>, signedIdentity, key, object, signature: value };
}

/** Signatures and the identities they name, with their schemas compiled by `validator`. */
export async function loadSignatures(validator: JsonSchemaValidator): Promise<Signatures> {
  return new Signatures(await loadIdentities(validator), await encodeSchema(signatureSchema, validator));
}
