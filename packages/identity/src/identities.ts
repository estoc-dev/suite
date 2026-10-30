import {
  decodeObject,
  digestOf,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonLink,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaValidator,
  json,
  type Link,
  linkOf,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { identityInterface, keyInterface } from "./interfaces.ts";
import { type Key, sameKey, verify } from "./key.ts";
import { type KeyObject, type Keys, loadKeys } from "./keys.ts";
import type { Signer } from "./signer.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Bytes in lowercase hex, the one way of writing each byte string. */
export const hexSchema: JsonObject = { type: "string", pattern: "^(?:[0-9a-f]{2})*$" };

/**
 * The schema of an Identity, the identity of a key on its own, whatever the
 * scheme of the key. It holds its root and nothing else, so each key has
 * one, with one link, and its root alone signs for it. A signature for it is
 * the root's signature.
 */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  "x-implements": { $link: identityInterface.link },
  type: "object",
  properties: { root: linkSchema },
  required: ["root"],
  additionalProperties: false,
};

/**
 * The schema of a Delegated Identity, a root and the keys it lists to sign
 * for it, its agents. A signature for it is the index of the agent that
 * signs, one byte, followed by that agent's signature, so it lists at most
 * 256 agents, in the order the root gives. It lists each once, or one signature would verify under two
 * indexes, as two signatures with two links. The root signs for it only if
 * it lists itself, and with no agents no one signs for it.
 */
export const delegatedIdentitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Delegated Identity",
  "x-implements": { $link: identityInterface.link },
  type: "object",
  properties: {
    root: linkSchema,
    agents: { type: "array", items: linkSchema, maxItems: 256, uniqueItems: true },
  },
  required: ["root", "agents"],
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
export type DelegatedIdentityData = IdentityData & { readonly agents: readonly JsonLink<KeyObject>[] };

/**
 * Someone who signs, as others see them: an identity read from its object
 * with its root, whichever identity schema the object is written to. It is
 * what both schemas name as the Identity interface, and all a reader that
 * does not sign needs. Someone is their root: two identities are of the same
 * someone when the links of their roots are the same, and an object that
 * names someone names their root by that link, while a signature names a
 * signed identity of the identity it is made for. Which keys sign for an
 * identity, and how their signatures are laid out, is for its schema to say.
 *
 * `blobs` are what it takes to read the identity again: the bytes of its
 * object and of the keys it names, and of the schemas they are written to,
 * each once. Reading does not need the interfaces those schemas name, but a
 * store takes in a blob only with all it leads to, so their bytes come along
 * as well.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly root: KeyObject;
  readonly blobs: readonly Uint8Array[];
}

/** An identity written to `delegatedIdentitySchema`, with its agents in the order its root lists them. */
export interface DelegatedIdentityObject extends IdentityObject {
  readonly data: DelegatedIdentityData;
  readonly agents: readonly KeyObject[];
}

export type SignedIdentityData = { readonly identity: JsonLink<IdentityObject>; readonly signature: string };

/**
 * An identity as its root publishes it: an object written to
 * `signedIdentitySchema`, read with the identity and verified, the bytes
 * being the root's signature over the identity's link, whichever identity
 * schema it is written to. What the
 * root publishes is this object as it is, so a signature names the identity
 * it is made for by the link of this object. Two signers are the same
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

/** Signs the digest of an object by the digest of a signed identity, giving the bytes of a signature for its identity. */
export type Sign = (object: Uint8Array, signedIdentity: Uint8Array) => Promise<Uint8Array>;

/**
 * What an identity schema says of the identities written to it: the keys
 * each names, which of them sign for it, and how the bytes of a signature
 * for it are laid out. Each identity schema has its own, found by the
 * schema's link, so signatures for any identity are read and made the same
 * way, and an identity schema added later is one more of these.
 */
export interface Rules<Identity extends IdentityObject = IdentityObject> {
  /** The identity `object` is, with the keys it names read from `reader`. */
  read(object: EncodedObject<Json, Identity["data"]>, keys: Keys, reader: Reader): Promise<Identity>;
  /**
   * The key that signs for `identity` and made `signature`, signing the
   * digest `object` by the digest `signedIdentity`; undefined when none did.
   */
  verify(
    identity: Identity,
    object: Uint8Array,
    signature: Uint8Array,
    signedIdentity: Uint8Array,
  ): KeyObject | undefined;
  /** How `signer` signs for `identity`; undefined when its key does not. */
  signing(identity: Identity, signer: Signer): Sign | undefined;
}

const identityRules: Rules = {
  async read(object, keys, reader) {
    return identityOf(object, await keys.read(object.data.root.$link, reader));
  },
  verify: ({ root }, object, signature, signedIdentity) =>
    verify(root, object, signature, signedIdentity) ? root : undefined,
  signing: ({ root }, signer) =>
    sameKey(signer.key, root) ? (object, signedIdentity) => signer.sign(object, signedIdentity) : undefined,
};

const delegatedIdentityRules: Rules<DelegatedIdentityObject> = {
  async read(object, keys, reader) {
    const { root, agents } = object.data;
    const read = (key: JsonLink<KeyObject>) => keys.read(key.$link, reader);
    return delegatedIdentityOf(object, await read(root), await Promise.all(agents.map(read)));
  },
  verify({ agents }, object, signature, signedIdentity) {
    const [index] = signature;
    const agent = index === undefined ? undefined : agents[index];
    return agent !== undefined && verify(agent, object, signature.subarray(1), signedIdentity) ? agent : undefined;
  },
  signing({ agents }, signer) {
    const index = agents.findIndex((agent) => sameKey(agent, signer.key));
    if (index < 0) return undefined;
    return async (object, signedIdentity) =>
      concatBytes(Uint8Array.of(index), await signer.sign(object, signedIdentity));
  },
};

const rules: ReadonlyMap<Link<Schema<Json>>, Rules> = new Map([
  [linkOf(json.encode(identitySchema)), identityRules],
  [linkOf(json.encode(delegatedIdentitySchema)), delegatedIdentityRules],
]);

/** The rules of the schema an identity's object is written to. */
export function rulesOf(object: EncodedObject<Json, IdentityData>): Rules {
  const found = rules.get(object.schema.link);
  if (found === undefined) throw new Error(`${object.schema.link} is not an identity schema`);
  return found;
}

/** Reads and writes identities, with their schemas and the keys they name. */
export class Identities {
  readonly keys: Keys;
  readonly #schema: Schema<Json, IdentityData>;
  readonly #delegatedSchema: Schema<Json, DelegatedIdentityData>;
  readonly #signedSchema: Schema<Json, SignedIdentityData>;
  readonly #schemas: ReadonlyMap<Link<Schema<Json>>, Schema<Json, IdentityData>>;

  constructor(
    keys: Keys,
    schema: Schema<Json, IdentityData>,
    delegated: Schema<Json, DelegatedIdentityData>,
    signed: Schema<Json, SignedIdentityData>,
  ) {
    this.keys = keys;
    this.#schema = schema;
    this.#delegatedSchema = delegated;
    this.#signedSchema = signed;
    this.#schemas = new Map([schema, delegated].map((each) => [each.link, each]));
  }

  /** Writes the Identity whose root is `root`. */
  encode(root: Key): IdentityObject {
    const key = this.keys.encode(root);
    return identityOf(encodeObject(this.#schema, { root: { $link: key.link } }), key);
  }

  /**
   * Reads the signed identity that `link` names from `reader`, with its
   * identity, written to either identity schema, and the keys it names, and
   * refuses it unless the identity's root signed it.
   */
  async read(link: Link<SignedIdentityObject>, reader: Reader): Promise<SignedIdentityObject> {
    const object = await readObject(reader, link, this.#signedSchema);
    return signedOf(object, await this.#readIdentity(object.data.identity.$link, reader));
  }

  /** Writes the Identity whose root is `root`'s key, and has `root` sign it. */
  async publish(root: Signer): Promise<SignedIdentityObject> {
    return this.#signedBy(root, this.encode(root.key));
  }

  /**
   * Writes the Delegated Identity whose root is `root`'s key and whose agents
   * are `agents`, in that order, and has `root` sign it.
   */
  async delegate(root: Signer, agents: readonly Key[]): Promise<SignedIdentityObject> {
    const rootKey = this.keys.encode(root.key);
    const agentKeys = agents.map((agent) => this.keys.encode(agent));
    const data = { root: { $link: rootKey.link }, agents: agentKeys.map(({ link }) => ({ $link: link })) };
    return this.#signedBy(root, delegatedIdentityOf(encodeObject(this.#delegatedSchema, data), rootKey, agentKeys));
  }

  // An identity stands for someone only as its root signed it, so it is read
  // only as the identity of a signed identity.
  async #readIdentity(link: Link<IdentityObject>, reader: Reader): Promise<IdentityObject> {
    const bytes = await reader.get(link);
    if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
    const schema = this.#schemas.get(schemaOf(bytes, json));
    if (schema === undefined) throw new Error(`${link} is not written to an identity schema`);
    const object = decodeObject(bytes, schema);
    if (object.link !== link) throw new Error(`the blob given for ${link} is another blob`);
    return rulesOf(object).read(object, this.keys, reader);
  }

  // The identity is written before its root is asked to sign, so a root is
  // not asked to sign an identity that would not read.
  async #signedBy(root: Signer, identity: IdentityObject): Promise<SignedIdentityObject> {
    const signature = await root.sign(digestOf(identity.link));
    const data = { identity: { $link: identity.link }, signature: bytesToHex(signature) };
    return signedOf(encodeObject(this.#signedSchema, data), identity);
  }
}

function identityOf(
  object: EncodedObject<Json, IdentityData>,
  root: KeyObject,
  keys: readonly KeyObject[] = [root],
): IdentityObject {
  return { ...object, link: object.link as Link<IdentityObject>, root, blobs: blobsOf(object, keys) };
}

function delegatedIdentityOf(
  object: EncodedObject<Json, DelegatedIdentityData>,
  root: KeyObject,
  agents: readonly KeyObject[],
): DelegatedIdentityObject {
  return { ...identityOf(object, root, [root, ...agents]), data: object.data, agents };
}

// A key can be both root and agent, and keys of one scheme share a schema,
// yet each blob is carried once.
function blobsOf(object: EncodedObject<Json>, keys: readonly KeyObject[]): Uint8Array[] {
  const blobs = new Map<Link<unknown>, Uint8Array>();
  const schemas = keys.map(({ schema }) => schema);
  for (const { link, bytes } of [object, ...keys, object.schema, ...schemas, identityInterface, keyInterface]) {
    blobs.set(link, bytes);
  }
  return [...blobs.values()];
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
    await encodeSchema(delegatedIdentitySchema, validator),
    await encodeSchema(signedIdentitySchema, validator),
  );
}
