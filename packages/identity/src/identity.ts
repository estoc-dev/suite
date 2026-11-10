import {
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  type Json,
  type JsonLink,
  type JsonSchema,
  type Link,
  linkSchema,
  type Reader,
  type Schema,
} from "@estoc/object";
import { concatBytes } from "@noble/hashes/utils.js";
import { blobsOf } from "./blobs.ts";
import { isSameKey, type Key, type KeyObject, verify } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";

/**
 * The schema of an Identity, whatever the scheme of its keys: a root, the
 * keys it lists to sign for it, its agents, and `at`.
 *
 * - `prior` names the signed identity it follows, and one without it starts a
 *   chain.
 * - `crisis` marks it as a crisis, after which no identity version before it
 *   counts.
 * - A signature for it is the index of the key that signs, one byte, followed
 *   by that key's signature. The root is 0 and the agents follow in the order
 *   the root lists them, so it lists at most 255.
 * - It lists each agent once and not its root, or one signature would verify
 *   under two indexes, as two signatures with two links.
 */
export const identitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Identity",
  type: "object",
  properties: {
    prior: linkSchema,
    root: linkSchema,
    agents: { type: "array", items: linkSchema, maxItems: 255, uniqueItems: true },
    crisis: { const: true },
    at: { type: "integer", minimum: 0 },
  },
  required: ["root", "agents", "at"],
  additionalProperties: false,
};

export type IdentityData = {
  readonly prior?: JsonLink<SignedIdentityObject>;
  readonly root: JsonLink<KeyObject>;
  readonly agents: readonly JsonLink<KeyObject>[];
  readonly crisis?: true;
  readonly at: number;
};

/**
 * Someone who signs, as others see them: an identity read from its object
 * with its root, its agents and the signed identity it follows.
 *
 * - Someone is their root: two identities are of the same someone when the
 *   links of their roots are the same. An object that names someone names
 *   their root by that link, while a signature names a signed identity of
 *   the identity it is made for.
 * - Its root signs for it, and so do its agents.
 * - `at` is when the root signs it, in milliseconds since the Unix epoch by
 *   the root's clock. Each identity a root signs is an identity version.
 * - `prior` is of the same root, and earlier.
 * - `blobs` are the identity's closure, each blob once: the bytes of its
 *   object and of the keys it names, the blobs of the schemas they are
 *   written to, and those of `prior`.
 */
export interface IdentityObject extends EncodedObject<Json, IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly prior: SignedIdentityObject | undefined;
  readonly root: KeyObject;
  readonly agents: readonly KeyObject[];
  readonly blobs: readonly Uint8Array[];
}

/** What a root says in an identity besides itself, by the keys and the signed identity it names. */
export interface IdentityContent {
  readonly prior?: SignedIdentityObject;
  readonly agents?: readonly Key[];
  readonly isCrisis?: boolean;
  /** Now, when it is not given. */
  readonly at?: number;
}

/** Signs the digest of an object by the digest of a signed identity, giving the bytes of a signature for its identity. */
export type SigningFunction = (object: Uint8Array, signedIdentity: Uint8Array) => Promise<Uint8Array>;

/** Identities, written to `identitySchema` and read with the keys they name and the signed identity they follow. */
export class Identities {
  readonly schema: Schema<Json, IdentityData>;
  readonly #keys: Keys;

  constructor(schema: Schema<Json, IdentityData>, keys: Keys) {
    this.schema = schema;
    this.#keys = keys;
  }

  /**
   * The identity of `root` that `content` says.
   *
   * @throws when `prior` is of another root, or is not earlier.
   * @throws when the agents list `root`, or do not fit the schema, as one
   *   listed twice does not.
   */
  encode(root: Key, { prior, agents = [], isCrisis = false, at = Date.now() }: IdentityContent = {}): IdentityObject {
    const rootKey = this.#keys.encode(root);
    const agentKeys = agents.map((agent) => this.#keys.encode(agent));
    const data: IdentityData = {
      ...(prior === undefined ? {} : { prior: { $link: prior.link } }),
      root: { $link: rootKey.link },
      agents: agentKeys.map(({ link }) => ({ $link: link })),
      ...(isCrisis ? { crisis: true } : {}),
      at,
    };
    return identityOf(encodeObject(this.schema, data), prior, rootKey, agentKeys);
  }

  /**
   * Reads `object` with the keys it names from `reader`, as following
   * `prior`, which the caller reads.
   *
   * @throws when `prior` is not the signed identity that `object` names as
   *   its prior, is of another root, or is not earlier.
   * @throws when its agents list its root.
   */
  async read(
    object: EncodedObject<Json, IdentityData>,
    prior: SignedIdentityObject | undefined,
    reader: Reader,
  ): Promise<IdentityObject> {
    if (object.data.prior?.$link !== prior?.link) throw new Error(`${object.link} does not follow ${prior?.link}`);
    const read = (key: JsonLink<KeyObject>) => this.#keys.read(key.$link, reader);
    return identityOf(object, prior, await read(object.data.root), await Promise.all(object.data.agents.map(read)));
  }
}

/** The key that signs for `identity` and made `signature`, signing the digest `object` by the digest `signedIdentity`; undefined when none did. */
export function signerOf(
  identity: IdentityObject,
  object: Uint8Array,
  signature: Uint8Array,
  signedIdentity: Uint8Array,
): KeyObject | undefined {
  const [index] = signature;
  const key = index === undefined ? undefined : signersOf(identity)[index];
  return key !== undefined && verify(key, object, signature.subarray(1), signedIdentity) ? key : undefined;
}

/** How `signer` signs for `identity`; undefined when its key does not. */
export function signingFunction(identity: IdentityObject, signer: Signer): SigningFunction | undefined {
  const index = signersOf(identity).findIndex((key) => isSameKey(key, signer.key));
  if (index < 0) return undefined;
  return async (object, signedIdentity) => concatBytes(Uint8Array.of(index), await signer.sign(object, signedIdentity));
}

export function hasSigner(identity: IdentityObject, key: KeyObject): boolean {
  return signersOf(identity).some(({ link }) => link === key.link);
}

/** The keys that sign for `identity`, by the index a signature names them by. */
function signersOf({ root, agents }: IdentityObject): readonly KeyObject[] {
  return [root, ...agents];
}

function identityOf(
  object: EncodedObject<Json, IdentityData>,
  prior: SignedIdentityObject | undefined,
  root: KeyObject,
  agents: readonly KeyObject[],
): IdentityObject {
  if (prior !== undefined && prior.identity.root.link !== root.link) {
    throw new Error(`${object.link} has another root than ${prior.link}, which it follows`);
  }
  if (prior !== undefined && object.data.at <= prior.identity.data.at) {
    throw new Error(`${object.link} is not later than ${prior.link}, which it follows`);
  }
  if (agents.some(({ link }) => link === root.link)) throw new Error(`${object.link} lists its root as an agent`);
  return {
    ...object,
    link: object.link as Link<IdentityObject>,
    prior,
    root,
    agents,
    blobs: blobsOf([object, root, ...agents], prior?.blobs),
  };
}
