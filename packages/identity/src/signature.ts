import {
  digestOf,
  type EncodedObject,
  encodeObject,
  type Fields,
  type Json,
  type Link,
  objectsOf,
  type Reader,
  readObject,
  type Schema,
  SelectionBySchema,
} from "@estoc/object";
import { bytes, type DataOf, link, schema } from "@estoc/schema";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { signerOf, signingFunction } from "./identity.ts";
import type { KeyObject } from "./key/interface.ts";
import type { SignedIdentities, SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";

/**
 * The schema every signature is written to, whatever the scheme of the key
 * that signs. A reader that reads a signature as an object of this schema,
 * such as a viewer, reads its fields without verifying it.
 *
 * `signature` holds bytes in hex, and the schema says no more of them. The
 * schema of the identity the signature is made for says which key signs and
 * how the bytes are laid out, and that key's scheme how its signature in them
 * reads. However they are laid out, they stay bytes, so this schema and those
 * who read signatures by it do not change for a scheme added later.
 */
export const signatureSchema = schema("Signature", {
  signedIdentity: link<SignedIdentityObject>(),
  object: link<never>(),
  signature: bytes(),
});

export type SignatureData = DataOf<typeof signatureSchema>;

/**
 * An identity standing behind an object, as an object written to
 * `signatureSchema`, read and verified, with `key`, the key that signed for
 * the identity.
 *
 * - That is all it says: who has to sign, in what role and by when are for
 *   the application that reads the object to decide.
 * - It names the object by link, so it verifies without the object, but not
 *   without the blobs of its signed identity.
 * - It travels apart from other signatures over the same object.
 * - It does not say what the object is, so its link reads as any.
 */
export interface Signature extends EncodedObject<Json, SignatureData> {
  readonly link: Link<Signature>;
  readonly signedIdentity: SignedIdentityObject;
  readonly key: KeyObject;
  readonly object: Link<never>;
  readonly signature: Uint8Array;
}

/** Whether a reader honors a signature, by the identity versions it has seen. */
export interface SeenIdentityVersions {
  /**
   * Whether the reader honors `signature`, by the identity versions of
   * whoever signed it that the reader has seen, and the one it carries with
   * those it follows.
   *
   * - Of those, the latest crisis and the ones that follow it count, or all
   *   of them when none is a crisis. A root signs a crisis when it no longer
   *   relies on what it signed before, so the signatures by an identity
   *   version before it are not honored, the root's own among them.
   * - The identity version it carries counts.
   * - The key that made it signs for the current identity version, the
   *   latest that counts. The one it carries is among them, as a device a
   *   wallet has just listed signs by an identity version the reader has not
   *   seen yet.
   */
  honors(signature: Signature): Promise<boolean>;
}

/**
 * A reader that has seen no identity versions, so a signature is honored by
 * the identity version it carries and those it follows alone. No crisis comes
 * after the one it carries among them, so it is honored once it verifies.
 */
export const noIdentityVersions: SeenIdentityVersions = { honors: async () => true };

/** A signature, read without verifying it, with the object it signs, read with the schema it is written to. */
export interface SignatureOver<F extends Fields<Json>> {
  readonly signature: EncodedObject<Json, SignatureData>;
  readonly object: EncodedObject<Json, F>;
}

/**
 * A signer acting for an identity it signs for, as one signed identity of
 * it, which every signature it makes names.
 */
export interface Actor {
  readonly signedIdentity: SignedIdentityObject;
  /**
   * Signs the link of an object, and so the object, whatever it is read as.
   * The signature's `signedIdentity.blobs` go along with it.
   *
   * @throws when the signer's signature does not verify.
   */
  sign(object: { readonly link: Link<unknown> }): Promise<Signature>;
}

/** Signatures, verified and made with their schema and the signed identities they name. */
export class Signatures {
  readonly schema = signatureSchema;
  readonly #signedIdentities: SignedIdentities;

  constructor(signedIdentities: SignedIdentities) {
    this.#signedIdentities = signedIdentities;
  }

  /**
   * Verifies `signature`, giving it with its signed identity and the key that
   * made it.
   *
   * - The signed identity, its identity and the keys it names are read from
   *   `reader`.
   * - The identity's schema says which key made the signature and how its
   *   bytes are laid out, and the key's scheme how its signature is read.
   *
   * @throws when `signature` is not written to the signature schema.
   * @throws when no key that signs for the identity signed the object it
   *   names by that signed identity.
   * @throws when `seenIdentityVersions` do not honor it.
   */
  async verify(
    signature: EncodedObject<Json, SignatureData>,
    reader: Reader,
    seenIdentityVersions: SeenIdentityVersions,
  ): Promise<Signature> {
    if (signature.schema.link !== this.schema.link) throw new Error(`a signature is written to ${this.schema.link}`);
    const signedIdentity = await this.#signedIdentities.read(signature.data.signedIdentity.$link, reader);
    const verifiedSignature = this.#signatureOf(signature, signedIdentity);
    if (!(await seenIdentityVersions.honors(verifiedSignature))) {
      throw new Error(
        `the signature by ${verifiedSignature.key.link} is not honored by the identity versions of ${signedIdentity.identity.identifier}`,
      );
    }
    return verifiedSignature;
  }

  /** Reads the signature that `link` names from `reader`, and verifies it by `seenIdentityVersions`. */
  async read(link: Link<Signature>, reader: Reader, seenIdentityVersions: SeenIdentityVersions): Promise<Signature> {
    return this.verify(await readObject(reader, link, this.schema), reader, seenIdentityVersions);
  }

  /**
   * The selection of the signatures over objects of `schema`, each read with
   * the object it signs.
   *
   * - A signature over an object of another schema is left out.
   * - It does not verify them, as what a selection takes depends on the
   *   record and its closure alone, and whether a signature is honored
   *   depends on the identity versions a reader has seen.
   *
   * @throws from `read`, when the reader gives no blob for the object, and
   *   where `decodeObject` throws for an object of `schema`.
   */
  selectionOver<F extends Fields<Json>>(
    schema: Schema<Json, F>,
  ): SelectionBySchema<Json, SignatureOver<F>, SignatureData> {
    const objects = objectsOf(schema);
    return new SelectionBySchema(this.schema, async (signature, reader) => {
      const object = await objects.read(signature.data.object.$link, reader);
      return object === undefined ? undefined : { signature, object };
    });
  }

  /**
   * An actor for `signedIdentity`.
   *
   * @throws when `signer`'s key does not sign for its identity.
   */
  actor(signer: Signer, signedIdentity: SignedIdentityObject): Actor {
    const sign = signingFunction(signedIdentity.identity, signer);
    if (sign === undefined) throw new Error(`the signer's key does not sign for ${signedIdentity.identity.link}`);
    const by = digestOf(signedIdentity.link);
    return {
      signedIdentity,
      sign: async (object) => {
        const data = {
          signedIdentity: { $link: signedIdentity.link },
          object: { $link: object.link as Link<never> },
          signature: bytesToHex(await sign(digestOf(object.link), by)),
        };
        return this.#signatureOf(encodeObject(this.schema, data), signedIdentity);
      },
    };
  }

  #signatureOf(signature: EncodedObject<Json, SignatureData>, signedIdentity: SignedIdentityObject): Signature {
    const object = signature.data.object.$link;
    const value = hexToBytes(signature.data.signature);
    const key = signerOf(signedIdentity.identity, digestOf(object), value, digestOf(signedIdentity.link));
    if (key === undefined) throw new Error(`the signature does not verify for ${object}`);
    return { ...signature, link: signature.link as Link<Signature>, signedIdentity, key, object, signature: value };
  }
}
