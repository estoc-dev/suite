import {
  digestOf,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonLink,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaValidator,
  type Link,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type Key, verify } from "./key.ts";
import { type KeyObject, type Keys, loadKeys } from "./keys.ts";
import type { Signer } from "./signer.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Bytes in lowercase hex, the one way of writing each byte string. */
export const hexSchema: JsonObject = { type: "string", pattern: "^(?:[0-9a-f]{2})*$" };

/** The schema every identity is written to, whatever the scheme of its root. */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  type: "object",
  properties: { root: linkSchema },
  required: ["root"],
  additionalProperties: false,
};

/** The schema every signed identity is written to, whatever the scheme of its root. */
export const signedIdentitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Signed Identity",
  type: "object",
  properties: { identity: linkSchema, signature: hexSchema },
  required: ["identity", "signature"],
  additionalProperties: false,
};

export type IdentityData = { readonly root: JsonLink<KeyObject> };

/**
 * Someone who signs, as others see them: an object written to
 * `identitySchema`, `{"$describedBy": <link to identitySchema>, "root":
 * <link to a key>}`, read with its root, the key that signs for it. It holds
 * its root and nothing else, so each key has one identity, with one link.
 * Someone is their root: two identities are of the same someone when the
 * links of their roots are the same, and an object that names someone names
 * their root by that link, while a signature names a signed identity of the
 * identity that makes it.
 *
 * `blobs` are what it takes to read the identity again: the bytes of its
 * object and of its root's, and of the schemas they are written to.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly root: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

export type SignedIdentityData = { readonly identity: JsonLink<IdentityObject>; readonly signature: string };

/**
 * An identity as its root stands behind it: an object written to
 * `signedIdentitySchema`, `{"$describedBy": <link to signedIdentitySchema>,
 * "identity": <link to the identity>, "signature": <hex>}`, read with the
 * identity and verified, the bytes being the root's signature over the
 * identity's link. A signature names the identity that makes it by the link
 * of this object. A wallet need not sign deterministically, so one identity
 * can have several, and each of them stands for it: two signers are the same
 * someone when the roots of their identities are the same, whichever signed
 * identities they sign by.
 *
 * `blobs` are what it takes to read it again: the bytes of its object and of
 * its schema, and the identity's `blobs`.
 */
export interface SignedIdentityObject extends EncodedObject<Json, SignedIdentityData> {
  readonly link: Link<SignedIdentityObject>;
  readonly identity: IdentityObject;
  readonly signature: Uint8Array;
  readonly blobs: readonly Uint8Array[];
}

/** Reads and writes identities, with their schemas and the keys they name. */
export class Identities {
  readonly keys: Keys;
  readonly #schema: Schema<Json, IdentityData>;
  readonly #signedSchema: Schema<Json, SignedIdentityData>;

  constructor(keys: Keys, schema: Schema<Json, IdentityData>, signed: Schema<Json, SignedIdentityData>) {
    this.keys = keys;
    this.#schema = schema;
    this.#signedSchema = signed;
  }

  /** Reads the identity that `link` names from `reader`, with its root. */
  async read(link: Link<IdentityObject>, reader: Reader): Promise<IdentityObject> {
    const object = await readObject(reader, link, this.#schema);
    return identityOf(object, await this.keys.read(object.data.root.$link, reader));
  }

  /** Writes the identity whose root is `root`. */
  encode(root: Key): IdentityObject {
    const key = this.keys.encode(root);
    return identityOf(encodeObject(this.#schema, { root: { $link: key.link } }), key);
  }

  /**
   * Reads the signed identity that `link` names from `reader`, with its
   * identity, and refuses it unless the identity's root signed it.
   */
  async readSigned(link: Link<SignedIdentityObject>, reader: Reader): Promise<SignedIdentityObject> {
    const object = await readObject(reader, link, this.#signedSchema);
    return signedOf(object, await this.read(object.data.identity.$link, reader));
  }

  /** Writes the identity whose root is `root`'s key, and has `root` sign it. */
  async publish(root: Signer): Promise<SignedIdentityObject> {
    const identity = this.encode(root.key);
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: { $link: identity.link }, signature: bytesToHex(signature) };
    return signedOf(encodeObject(this.#signedSchema, data), identity);
  }
}

function identityOf(object: EncodedObject<Json, IdentityData>, root: KeyObject): IdentityObject {
  return {
    ...object,
    link: object.link as Link<IdentityObject>,
    root,
    blobs: [object.bytes, root.bytes, object.schema.bytes, root.schema.bytes],
  };
}

function signedOf(object: EncodedObject<Json, SignedIdentityData>, identity: IdentityObject): SignedIdentityObject {
  const signature = hexToBytes(object.data.signature);
  if (!verify(identity.root, digestOf(identity.link), signature)) {
    throw new Error(`the root of ${identity.link} did not sign ${object.link}`);
  }
  return {
    ...object,
    link: object.link as Link<SignedIdentityObject>,
    identity,
    signature,
    blobs: [object.bytes, object.schema.bytes, ...identity.blobs],
  };
}

/** Identities and the keys they name, with their schemas compiled by `validator`. */
export async function loadIdentities(validator: JsonSchemaValidator): Promise<Identities> {
  return new Identities(
    await loadKeys(validator),
    await encodeSchema(identitySchema, validator),
    await encodeSchema(signedIdentitySchema, validator),
  );
}
