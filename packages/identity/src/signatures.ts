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
import { hexSchema, type Identities, loadIdentities, type SignedIdentityObject } from "./identities.ts";
import { sameKey, verify } from "./key.ts";
import type { Signer } from "./signer.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * The schema every signature is written to, whatever the scheme of the key
 * that signs. A reader that reads a signature as an object of this schema,
 * such as a viewer, reads its fields without verifying it.
 *
 * `signature` holds bytes in hex, and the schema says no more of them. What
 * the bytes hold is for the key's scheme to say: however a scheme lays out a
 * signature in them, they stay bytes, so this schema and those who read
 * signatures by it do not change for a scheme added later.
 */
export const signatureSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Signature",
  type: "object",
  properties: {
    identity: linkSchema,
    object: linkSchema,
    signature: hexSchema,
  },
  required: ["identity", "object", "signature"],
  additionalProperties: false,
};

export type SignatureData = {
  readonly identity: JsonLink<SignedIdentityObject>;
  readonly object: JsonLink<never>;
  readonly signature: string;
};

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`: `{"$describedBy": <link to signatureSchema>, "identity":
 * <link to the signed identity>, "object": <link to the object>, "signature":
 * <hex>}`, read and verified. That is all it says. Who has to sign, in what
 * role and by when are for the application that reads the object to decide.
 * It names the object by link, so it verifies without the object, but not
 * without the blobs of its identity. It travels apart from other signatures
 * over the same object. It does not say what the object is, so its link
 * reads as any.
 */
export interface Signature extends EncodedObject<Json, SignatureData> {
  readonly link: Link<Signature>;
  readonly identity: SignedIdentityObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
}

/**
 * A signer acting for an identity it is the root of, as one signed identity
 * of it, which every signature it makes names.
 */
export interface IdentityActor {
  readonly identity: SignedIdentityObject;
  /**
   * Signs the link of an object, and so the object, whatever it is read as.
   * The signature's `identity.blobs` go along with it. A signature that does
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
   * Gives a signature with its signed identity, and refuses it unless that
   * identity's root signed the object it names. The signed identity, its
   * identity and the root are read from `reader`, and the root's scheme says
   * how the signature's bytes are read. One identity can sign one object
   * many times, since a wallet need not sign deterministically, and each of
   * those signatures verifies.
   */
  async verify(signature: EncodedObject<Json, SignatureData>, reader: Reader): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    return signatureOf(signature, await this.identities.readSigned(signature.data.identity.$link, reader));
  }

  /** Reads the signature that `link` names from `reader`, and verifies it. */
  async read(link: Link<Signature>, reader: Reader): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  /** An actor for `identity`, which refuses a signer that is not its root. */
  actor(signer: Signer, identity: SignedIdentityObject): IdentityActor {
    if (!sameKey(signer.key, identity.identity.root)) {
      throw new Error(`the signer's key is not the root of ${identity.identity.link}`);
    }
    const schema = this.schema;
    return {
      identity,
      async sign(object) {
        const data = {
          identity: { $link: identity.link },
          object: { $link: object.link as Link<never> },
          signature: bytesToHex(await signer.sign(digestOf(object.link))),
        };
        return signatureOf(encodeObject(schema, data), identity);
      },
    };
  }
}

function signatureOf(signature: EncodedObject<Json, SignatureData>, identity: SignedIdentityObject): Signature {
  const object = signature.data.object.$link;
  const value = hexToBytes(signature.data.signature);
  if (!verify(identity.identity.root, digestOf(object), value)) {
    throw new Error(`the signature does not verify for ${object}`);
  }
  return { ...signature, link: signature.link as Link<Signature>, identity, object, signature: value };
}

/** Signatures and the identities they name, with their schemas compiled by `validator`. */
export async function loadSignatures(validator: JsonSchemaValidator): Promise<Signatures> {
  return new Signatures(await loadIdentities(validator), await encodeSchema(signatureSchema, validator));
}
