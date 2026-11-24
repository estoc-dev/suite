import {
  digestOf,
  type EncodedObject,
  encodeObject,
  type Implementation,
  type Link,
  LinkValue,
  type Reader,
  readObject,
} from "@estoc/object";
import { bytes, type DataOf, link, schema } from "@estoc/schema";
import { LRUCache } from "lru-cache";
import { distinctBlobsOf } from "./blobs.ts";
import type { Identities, IdentityObject } from "./identity.ts";
import { verify } from "./key/interface.ts";
import type { Signer } from "./signer.ts";

export const signedIdentitySchema = schema("Signed Identity", {
  identity: link(),
  signature: bytes(),
});

export type SignedIdentityData = DataOf<typeof signedIdentitySchema>;

export interface SignedIdentityObject {
  readonly link: Link<unknown>;
  readonly identity: IdentityObject;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/**
 * What a signed identity reads as depends on it and its closure alone, so one that has read is kept
 * by its link and given again without asking the reader: its closure is in `blobs`.
 */
export class SignedIdentities {
  readonly schema = signedIdentitySchema;
  readonly implementation: Implementation<SignedIdentityObject, SignedIdentityData> = {
    schema: signedIdentitySchema,
    read: (object, reader) => this.verify(object, reader),
  };
  readonly #identities: Identities;
  readonly #cache = new LRUCache<Link<unknown>, SignedIdentityObject>({ max: 1_000 });

  constructor(identities: Identities) {
    this.#identities = identities;
  }

  async verify(object: EncodedObject<SignedIdentityData>, reader: Reader): Promise<SignedIdentityObject> {
    const kept = this.#cache.get(object.link);
    if (kept !== undefined) return kept;
    if (object.schema.link !== this.schema.link) throw new Error(`a signed identity is written to ${this.schema.link}`);
    const identity = await readObject(reader, object.data.identity.link, this.#identities.schema);
    const prior = identity.data.prior === undefined ? undefined : await this.read(identity.data.prior.link, reader);
    return this.#signedIdentityOf(object, await this.#identities.read(identity, prior, reader));
  }

  async read(link: Link<unknown>, reader: Reader): Promise<SignedIdentityObject> {
    return this.#cache.get(link) ?? this.verify(await readObject(reader, link, this.schema), reader);
  }

  /**
   * The identity is written before its root is asked to sign, so a root is not asked to sign an
   * identity that would not read.
   */
  async sign(root: Signer, identity: IdentityObject): Promise<SignedIdentityObject> {
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: new LinkValue(identity.link), signature };
    return this.#signedIdentityOf(encodeObject(this.schema, data), identity);
  }

  #signedIdentityOf(object: EncodedObject<SignedIdentityData>, identity: IdentityObject): SignedIdentityObject {
    const { signature } = object.data;
    if (!verify(identity.root, digestOf(identity.link), signature)) {
      throw new Error(`the root of ${identity.link} did not sign ${object.link}`);
    }
    const signedIdentity = { link: object.link, identity, signature, blobs: distinctBlobsOf(object, identity.blobs) };
    this.#cache.set(object.link, signedIdentity);
    return signedIdentity;
  }
}
