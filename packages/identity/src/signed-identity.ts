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
import { blobsOf } from "./blobs.ts";
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

export class SignedIdentities {
  readonly schema = signedIdentitySchema;
  readonly implementation: Implementation<SignedIdentityObject, SignedIdentityData> = {
    schema: signedIdentitySchema,
    read: (object, reader) => this.verify(object, reader),
  };
  readonly #identities: Identities;

  constructor(identities: Identities) {
    this.#identities = identities;
  }

  async verify(object: EncodedObject<SignedIdentityData>, reader: Reader): Promise<SignedIdentityObject> {
    if (object.schema.link !== this.schema.link) throw new Error(`a signed identity is written to ${this.schema.link}`);
    const identity = await readObject(reader, object.data.identity.link, this.#identities.schema);
    const prior = identity.data.prior === undefined ? undefined : await this.read(identity.data.prior.link, reader);
    return signedIdentityOf(object, await this.#identities.read(identity, prior, reader));
  }

  async read(link: Link<unknown>, reader: Reader): Promise<SignedIdentityObject> {
    return this.verify(await readObject(reader, link, this.schema), reader);
  }

  /**
   * The identity is written before its root is asked to sign, so a root is not asked to sign an
   * identity that would not read.
   */
  async sign(root: Signer, identity: IdentityObject): Promise<SignedIdentityObject> {
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: new LinkValue(identity.link), signature };
    return signedIdentityOf(encodeObject(this.schema, data), identity);
  }
}

function signedIdentityOf(object: EncodedObject<SignedIdentityData>, identity: IdentityObject): SignedIdentityObject {
  const { signature } = object.data;
  if (!verify(identity.root, digestOf(identity.link), signature)) {
    throw new Error(`the root of ${identity.link} did not sign ${object.link}`);
  }
  return { link: object.link, identity, signature, blobs: blobsOf(object, identity.blobs) };
}
