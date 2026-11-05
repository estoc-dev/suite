import {
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  type Json,
  type JsonLink,
  type JsonSchema,
  linkSchema,
  type Reader,
  type Schema,
} from "@estoc/object";
import { concatBytes } from "@noble/hashes/utils.js";
import { isSameKey, type Key, type KeyObject, verify } from "../key/interface.ts";
import type { Keys } from "../key/keys.ts";
import type { Signer } from "../signer.ts";
import {
  type IdentityData,
  type IdentityImplementation,
  type IdentityObject,
  identityOf,
  type SigningFunction,
} from "./interface.ts";

/**
 * The schema of a Delegated Identity, a root and the keys it lists to sign
 * for it, its agents. A signature for it is the index of the agent that
 * signs, one byte, followed by that agent's signature, so it lists at most
 * 256 agents, in the order the root gives. It lists each once, or one
 * signature would verify under two indexes, as two signatures with two
 * links. The root signs for it only if it lists itself, and with no agents
 * no one signs for it.
 */
export const delegatedIdentitySchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Delegated Identity",
  type: "object",
  properties: {
    root: linkSchema,
    agents: { type: "array", items: linkSchema, maxItems: 256, uniqueItems: true },
    at: { type: "integer", minimum: 0 },
  },
  required: ["root", "agents", "at"],
  additionalProperties: false,
};

export type DelegatedIdentityData = IdentityData & { readonly agents: readonly JsonLink<KeyObject>[] };

/** An identity written to `delegatedIdentitySchema`, with its agents in the order its root lists them. */
export interface DelegatedIdentityObject extends IdentityObject {
  readonly data: DelegatedIdentityData;
  readonly agents: readonly KeyObject[];
}

/** Delegated Identities, written to `delegatedIdentitySchema` and read with the keys they name. */
export class DelegatedIdentities implements IdentityImplementation<DelegatedIdentityObject> {
  readonly schema: Schema<Json, DelegatedIdentityData>;
  readonly #keys: Keys;

  constructor(schema: Schema<Json, DelegatedIdentityData>, keys: Keys) {
    this.schema = schema;
    this.#keys = keys;
  }

  encode(root: Key, agents: readonly Key[], at: number): DelegatedIdentityObject {
    const rootKey = this.#keys.encode(root);
    const agentKeys = agents.map((agent) => this.#keys.encode(agent));
    const data = { root: { $link: rootKey.link }, agents: agentKeys.map(({ link }) => ({ $link: link })), at };
    return delegatedIdentityOf(encodeObject(this.schema, data), rootKey, agentKeys);
  }

  async read(object: EncodedObject<Json, DelegatedIdentityData>, reader: Reader): Promise<DelegatedIdentityObject> {
    const { root, agents } = object.data;
    const read = (key: JsonLink<KeyObject>) => this.#keys.read(key.$link, reader);
    return delegatedIdentityOf(object, await read(root), await Promise.all(agents.map(read)));
  }

  verify(
    { agents }: DelegatedIdentityObject,
    object: Uint8Array,
    signature: Uint8Array,
    signedIdentity: Uint8Array,
  ): KeyObject | undefined {
    const [index] = signature;
    const agent = index === undefined ? undefined : agents[index];
    return agent !== undefined && verify(agent, object, signature.subarray(1), signedIdentity) ? agent : undefined;
  }

  signingFunction({ agents }: DelegatedIdentityObject, signer: Signer): SigningFunction | undefined {
    const index = agents.findIndex((agent) => isSameKey(agent, signer.key));
    if (index < 0) return undefined;
    return async (object, signedIdentity) =>
      concatBytes(Uint8Array.of(index), await signer.sign(object, signedIdentity));
  }

  hasSigner({ agents }: DelegatedIdentityObject, key: KeyObject): boolean {
    return agents.some(({ link }) => link === key.link);
  }
}

function delegatedIdentityOf(
  object: EncodedObject<Json, DelegatedIdentityData>,
  root: KeyObject,
  agents: readonly KeyObject[],
): DelegatedIdentityObject {
  return { ...identityOf(object, root, [root, ...agents]), data: object.data, agents };
}
