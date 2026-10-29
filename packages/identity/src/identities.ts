import {
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
import type { Key } from "./key.ts";
import { type KeyObject, type Keys, loadKeys } from "./keys.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** The schema every identity is written to, whatever the scheme of its root. */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  type: "object",
  properties: { root: linkSchema },
  required: ["root"],
  additionalProperties: false,
};

export type IdentityData = { readonly root: JsonLink<KeyObject> };

/**
 * Someone who signs, as others name them: an object written to
 * `identitySchema`, `{"$describedBy": <link to identitySchema>, "root":
 * <link to a key>}`, read with its root, the key that signs for it. A
 * signature, or any other object, names an identity by the link of this
 * object. It holds its root and nothing else, so each key has one identity,
 * with one link, and two identities are the same when their links are.
 *
 * `blobs` are what it takes to read the identity again: the bytes of its
 * object and of its root's, and of the schemas they are written to.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly root: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

/** Reads and writes identities, with their schema and the keys they name. */
export class Identities {
  readonly keys: Keys;
  readonly #schema: Schema<Json, IdentityData>;

  constructor(keys: Keys, schema: Schema<Json, IdentityData>) {
    this.keys = keys;
    this.#schema = schema;
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
}

function identityOf(object: EncodedObject<Json, IdentityData>, root: KeyObject): IdentityObject {
  return {
    ...object,
    link: object.link as Link<IdentityObject>,
    root,
    blobs: [object.bytes, root.bytes, object.schema.bytes, root.schema.bytes],
  };
}

/** Identities and the keys they name, with their schemas compiled by `validator`. */
export async function loadIdentities(validator: JsonSchemaValidator): Promise<Identities> {
  return new Identities(await loadKeys(validator), await encodeSchema(identitySchema, validator));
}
