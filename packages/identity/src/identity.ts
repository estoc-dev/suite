import { type EncodedObject, encodeObject, type Link, LinkValue, type Reader } from "@estoc/object";
import { array, boolean, type DataOf, integer, link, optional, schema } from "@estoc/schema";
import { concatBytes } from "@noble/hashes/utils.js";
import { distinctBlobsOf } from "./blobs.ts";
import { isSameKey, type Key, type KeyObject, verify } from "./key/interface.ts";
import type { Keys } from "./key/keys.ts";
import type { SignedIdentityObject } from "./signed-identity.ts";
import type { Signer } from "./signer.ts";

/**
 * - `crisis` is left out of an identity that is no crisis, so that it has one object.
 * - It lists each agent once and not its root, or one signature would verify under two indexes, as
 *   two signatures with two links.
 */
export const identitySchema = schema("Identity", {
  prior: optional(link()),
  root: link(),
  agents: array(link()),
  crisis: optional(boolean()),
  at: integer(),
});

export type IdentityData = DataOf<typeof identitySchema>;

/** `at` is when the root signs it, in milliseconds since the Unix epoch by the root's clock. */
export interface IdentityObject {
  readonly link: Link<unknown>;
  readonly identifier: Link<unknown>;
  readonly prior: SignedIdentityObject | undefined;
  readonly root: KeyObject;
  readonly agents: readonly KeyObject[];
  readonly at: number;
  readonly isCrisis: boolean;
  readonly blobs: readonly Uint8Array[];
}

export interface IdentityContent {
  readonly prior?: SignedIdentityObject;
  readonly agents?: readonly Key[];
  readonly isCrisis?: boolean;
  readonly at?: number;
}

export type SigningFunction = (object: Uint8Array, signedIdentity: Uint8Array) => Promise<Uint8Array>;

export class Identities {
  readonly schema = identitySchema;
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

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

  async read(
    object: EncodedObject<IdentityData>,
    prior: SignedIdentityObject | undefined,
    reader: Reader,
  ): Promise<IdentityObject> {
    if (object.data.prior?.link !== prior?.link) throw new Error(`${object.link} does not follow ${prior?.link}`);
    const read = (key: LinkValue<unknown>) => this.#keys.read(key.link, reader);
    return identityOf(object, prior, await read(object.data.root), await Promise.all(object.data.agents.map(read)));
  }
}

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

export function signingFunction(identity: IdentityObject, signer: Signer): SigningFunction | undefined {
  const index = signersOf(identity).findIndex((key) => isSameKey(key, signer.key));
  if (index < 0) return undefined;
  return async (object, signedIdentity) => concatBytes(Uint8Array.of(index), await signer.sign(object, signedIdentity));
}

export function hasSigner(identity: IdentityObject, key: KeyObject): boolean {
  return signersOf(identity).some(({ link }) => link === key.link);
}

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
  const { at, crisis } = object.data;
  if (prior !== undefined && at <= prior.identity.at) {
    throw new Error(`${object.link} is not later than ${prior.link}, which it follows`);
  }
  if (agents.some(({ link }) => link === root.link)) throw new Error(`${object.link} lists its root as an agent`);
  if (new Set(agents.map((agent) => agent.link)).size < agents.length) {
    throw new Error(`${object.link} lists an agent twice`);
  }
  if (agents.length > 255) throw new Error(`${object.link} lists more than 255 agents`);
  if (crisis === false) throw new Error(`${object.link} marks a crisis with true, or not at all`);
  return {
    link: object.link,
    identifier: root.link,
    prior,
    root,
    agents,
    at,
    isCrisis: crisis === true,
    blobs: distinctBlobsOf(
      object,
      [root, ...agents, ...(prior === undefined ? [] : [prior])].flatMap(({ blobs }) => blobs),
    ),
  };
}
