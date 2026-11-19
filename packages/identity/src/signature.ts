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

export interface SeenIdentityVersions {
  /**
   * A root signs a crisis when it no longer relies on what it signed before, so the signatures by
   * an identity version before it are not honored, the root's own among them. The one a signature
   * carries counts, as a device a wallet has just listed signs by an identity version the reader
   * has not seen yet.
   */
  honors(signature: Signature): Promise<boolean>;
}

export const noIdentityVersions: SeenIdentityVersions = { honors: async () => true };

export interface SignatureOver<F extends ValueMap> {
  readonly signature: Signature;
  readonly object: EncodedObject<F>;
}

export interface Actor {
  readonly signedIdentity: SignedIdentityObject;
  sign(object: { readonly link: Link<unknown> }): Promise<Signature>;
}

export class Signatures {
  readonly schema = signatureSchema;
  /**
   * It verifies by the identity version a signature carries alone, so what it reads depends on the
   * signature and its closure, and an index can read by it. Whether the signature is still honored
   * is for a reader's `SeenIdentityVersions` to say.
   */
  readonly implementation: Implementation<Signature, SignatureData> = {
    schema: signatureSchema,
    read: (signature, reader) => this.verify(signature, reader, noIdentityVersions),
  };
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
  }

  async verify(
    signature: EncodedObject<SignatureData>,
    reader: Reader,
    seenIdentityVersions: SeenIdentityVersions,
  ): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    const signedIdentity = await this.#signedIdentities.read(signature.data.signedIdentity.link, reader);
    const verifiedSignature = this.#signatureOf(signature, signedIdentity);
    if (!(await seenIdentityVersions.honors(verifiedSignature))) {
      throw new Error(
        `the signature by ${verifiedSignature.key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
      );
    }
    return verifiedSignature;
  }

  async read(link: Link<unknown>, reader: Reader, seenIdentityVersions: SeenIdentityVersions): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader, seenIdentityVersions);
  }

  selectionOver<F extends ValueMap>(schema: Schema<F>): SelectionBySchema<SignatureOver<F>, SignatureData> {
    const objects = objectsOf(schema);
    return new SelectionBySchema(this.schema, async (signature, reader) => {
      const object = await objects.read(signature.data.object.link, reader);
      if (object === undefined) return undefined;
      return { signature: await this.implementation.read(signature, reader), object };
    });
  }

  actor(signer: Signer, signedIdentity: SignedIdentityObject): Actor {
    const sign = signingFunction(signedIdentity.identity, signer);
    if (sign === undefined) throw new Error(`the signer's key does not sign for ${signedIdentity.identity.link}`);
    const by = digestOf(signedIdentity.link);
    return {
      signedIdentity,
      sign: async (object) => {
        const data = {
          signedIdentity: new LinkValue(signedIdentity.link),
          object: new LinkValue(object.link as Link<never>),
          signature: await sign(digestOf(object.link), by),
        };
        return this.#signatureOf(encodeObject(this.schema, data), signedIdentity);
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
