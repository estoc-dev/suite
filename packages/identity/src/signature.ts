import {
  digestOf,
  type EncodedObject,
  encodeObject,
  type Implementation,
  type Link,
  LinkValue,
  objectsOf,
  type Reader,
  readObject,
  type Schema,
  SelectionBySchema,
  type ValueMap,
} from "@estoc/object";
import { bytes, type DataOf, link, schema } from "@estoc/schema";
import { blobsOf } from "./blobs.ts";
import { signerOf, signingFunction } from "./identity.ts";
import type { KeyObject } from "./key/interface.ts";
import type { SignedIdentities, SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";

/**
 * `signature` holds bytes, and the schema says no more of them: the schema of the identity says
 * which key signs and how the bytes are laid out, so this schema does not change for a scheme added
 * later.
 */
export const signatureSchema = schema("Signature", {
  signedIdentity: link(),
  object: link<never>(),
  signature: bytes(),
});

export type SignatureData = DataOf<typeof signatureSchema>;

/**
 * Who has to sign, in what role and by when are for the application that reads the object to
 * decide.
 */
export interface Signature {
  readonly link: Link<unknown>;
  readonly signedIdentity: SignedIdentityObject;
  readonly key: KeyObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

export interface SignatureOver<F extends ValueMap> {
  readonly signature: Signature;
  readonly object: EncodedObject<F>;
}

export interface Actor {
  readonly identifier: Link<unknown>;
  sign(object: { readonly link: Link<unknown> }): Promise<Signature>;
}

/**
 * A signature is verified by the identity version it carries alone, so what is read depends on the
 * signature and its closure, and an index can read by it. Whether the signature is still honored
 * depends on the identity versions a reader has seen, which are not read here.
 */
export class Signatures {
  readonly schema = signatureSchema;
  readonly implementation: Implementation<Signature, SignatureData> = {
    schema: signatureSchema,
    read: (signature, reader) => this.verify(signature, reader),
  };
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
  }

  async verify(signature: EncodedObject<SignatureData>, reader: Reader): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    const signedIdentity = await this.#signedIdentities.read(signature.data.signedIdentity.link, reader);
    return this.#signatureOf(signature, signedIdentity);
  }

  async read(link: Link<unknown>, reader: Reader): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  selectionOver<F extends ValueMap>(schema: Schema<F>): SelectionBySchema<SignatureOver<F>, SignatureData> {
    const objects = objectsOf(schema);
    return new SelectionBySchema(this.schema, async (signature, reader) => {
      const object = await objects.read(signature.data.object.link, reader);
      if (object === undefined) return undefined;
      return { signature: await this.implementation.read(signature, reader), object };
    });
  }

  /**
   * `currentOf` is asked at each signature, since a reader takes in identity versions after the
   * actor is made, and a signature carries the one that is current then. It is given
   * `signedIdentity` as the one in hand, since a reader holds no identity version just published.
   */
  actor(
    signer: Signer,
    signedIdentity: SignedIdentityObject,
    currentOf: (inHand: SignedIdentityObject) => Promise<SignedIdentityObject>,
  ): Actor {
    const { identifier } = signedIdentity.identity;
    return {
      identifier,
      sign: async (object) => {
        const current = await currentOf(signedIdentity);
        if (current.identity.identifier !== identifier)
          throw new Error(
            `${current.link} is an identity version of ${current.identity.identifier}, and the actor signs for ${identifier}`,
          );
        const sign = signingFunction(current.identity, signer);
        if (sign === undefined) throw new Error(`the signer's key does not sign for ${current.identity.link}`);
        const data = {
          signedIdentity: new LinkValue(current.link),
          object: new LinkValue(object.link as Link<never>),
          signature: await sign(digestOf(object.link), digestOf(current.link)),
        };
        return this.#signatureOf(encodeObject(this.schema, data), current);
      },
    };
  }

  #signatureOf(signature: EncodedObject<SignatureData>, signedIdentity: SignedIdentityObject): Signature {
    const object = signature.data.object.link;
    const value = signature.data.signature;
    const key = signerOf(signedIdentity.identity, digestOf(object), value, digestOf(signedIdentity.link));
    if (key === undefined) throw new Error(`the signature does not verify for ${object}`);
    return {
      link: signature.link,
      signedIdentity,
      key,
      object,
      signature: value,
      blobs: blobsOf(signature, signedIdentity.blobs),
    };
  }
}
