import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader } from "@estoc/object";
import { array, boolean, type DataOf, integer, link, optional, schema } from "@estoc/schema";
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
 *   counts. An identity that is no crisis leaves it out, so that it has one
 *   object.
 * - A signature for it is the index of the key that signs, one byte, followed
 *   by that key's signature. The root is 0 and the agents follow in the order
 *   the root lists them, so it lists at most 255.
 * - It lists each agent once and not its root, or one signature would verify
 *   under two indexes, as two signatures with two links.
 */
export const identitySchema = schema("Identity", {
  prior: optional(link<SignedIdentityObject>()),
  root: link<KeyObject>(),
  agents: array(link<KeyObject>()),
  crisis: optional(boolean()),
  at: integer(),
});

export type IdentityData = DataOf<typeof identitySchema>;

/** What names someone across their identity versions: the link of their root. */
export type Identifier = Link<KeyObject>;

/**
 * Someone who signs, as others see them: an identity read from its object
 * with its root, its agents and the signed identity it follows.
 *
 * - Someone is their `identifier`: two identities are of the same someone
 *   when their identifiers are the same. An object that names someone names
 *   them by their identifier, while a signature names a signed identity of
 *   the identity it is made for.
 * - Its root signs for it, and so do its agents.
 * - `at` is when the root signs it, in milliseconds since the Unix epoch by
 *   the root's clock. Each identity a root signs is an identity version.
 * - `prior` is of the same root, and earlier.
 * - `blobs` are the identity's closure, each blob once: the bytes of its
 *   object and of the keys it names, the schemas they are written to, and
 *   the blobs of `prior`.
 */
export interface IdentityObject extends EncodedObject<IdentityData> {
  readonly link: Link<IdentityObject>;
  readonly identifier: Identifier;
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
  readonly schema = identitySchema;
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  /**
   * The identity of `root` that `content` says.
   *
   * @throws when `prior` is of another root, or is not earlier.
   * @throws when the agents list `root` or one of them twice, or are more
   *   than 255.
   */
  encode(root: Key, { prior, agents = [], isCrisis = false, at = Date.now() }: IdentityContent = {}): IdentityObject {
    const rootKey = this.#keys.encode(root);
    const agentKeys = agents.map((agent) => this.#keys.encode(agent));
    const data: IdentityData = {
      ...(prior === undefined ? {} : { prior: new LinkValue(prior.link) }),
      root: new LinkValue(rootKey.link),
      agents: agentKeys.map(({ link }) => new LinkValue(link)),
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
   * @throws when its agents list its root or one of them twice, or are more
   *   than 255.
   * @throws when it writes `crisis` as anything but `true`.
   */
  async read(
    object: EncodedObject<IdentityData>,
    prior: SignedIdentityObject | undefined,
    reader: Reader,
  ): Promise<IdentityObject> {
    if (object.data.prior?.link !== prior?.link) throw new Error(`${object.link} does not follow ${prior?.link}`);
    const read = (key: LinkValue<KeyObject>) => this.#keys.read(key.link, reader);
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
  object: EncodedObject<IdentityData>,
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
  if (new Set(agents.map((agent) => agent.link)).size < agents.length) {
    throw new Error(`${object.link} lists an agent twice`);
  }
  if (agents.length > 255) throw new Error(`${object.link} lists more than 255 agents`);
  if (object.data.crisis === false) throw new Error(`${object.link} marks a crisis with true, or not at all`);
  return {
    ...object,
    link: object.link as Link<IdentityObject>,
    identifier: root.link,
    prior,
    root,
    agents,
    blobs: blobsOf([object, root, ...agents], prior?.blobs),
  };
}
