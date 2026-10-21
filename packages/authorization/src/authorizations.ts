import { identityFromJson, identityToJson, sameIdentity, type Identity, type IdentityJson, type Signer } from "@estoc/identity";
import {
  decodeObject,
  decodeSignature,
  encodeObject,
  encodeSchema,
  linkOf,
  sign,
  type Bytes,
  type EncodedObject,
  type Link,
  type Schema,
  type SchemaValidator,
  type Signature,
} from "@estoc/object";
// Temporal is not yet in every runtime this runs in, nor in the TypeScript lib.
import { Temporal } from "temporal-polyfill";
import { authorizationSchema, proxySchema } from "./schemas.ts";

/** An object and one signature over it. */
export interface Signed {
  readonly object: EncodedObject;
  readonly signature: Signature;
}

/**
 * An Authorization Object and its authorizer's signature over it. The
 * authorizer lets `agent` act for it in full, authorizing others included.
 */
export interface Authorization extends Signed {
  readonly authorizer: Identity;
  readonly agent: Identity;
}

/**
 * One way an identity stands behind an object: by its own signature when
 * `agents` is empty, or else through these agents, in order from the one it
 * authorized to the one that signed the proxy.
 */
export interface Standing {
  readonly identity: Identity;
  readonly agents: readonly Identity[];
}

/** Blobs by their links: a Map, or a store that holds blobs by content. */
export interface Blobs {
  get(link: Link<unknown>): Uint8Array | undefined;
}

type AuthorizationData = { readonly agent: IdentityJson; readonly until?: string };
type ProxyData = { readonly target: Link<EncodedObject>; readonly chain: readonly Link<Signature>[] };

/** Authorizations and proxies, read and written with the schemas compiled once by one validator. */
export class Authorizations {
  readonly #authorization: Schema;
  readonly #proxy: Schema;

  constructor(authorization: Schema, proxy: Schema) {
    this.#authorization = authorization;
    this.#proxy = proxy;
  }

  /**
   * Signs an authorization that lets `agent` act for the signer, until the
   * RFC 3339 `date-time` `until` if one is given.
   */
  async authorize(agent: Identity, signer: Signer, until?: string): Promise<Authorization> {
    const object = encodeObject(
      this.#authorization,
      until === undefined ? { agent: identityToJson(agent) } : { agent: identityToJson(agent), until },
    );
    // Checked before the signer is asked, which may be a wallet prompting its holder.
    endOf(object);
    return authorizationOf(object, await sign(object, signer));
  }

  /** Reads an authorization from the blobs of its signature and its object. */
  readAuthorization(signature: Bytes<Signature>, object: Bytes<EncodedObject>): Authorization {
    return this.#authorizationFrom(decodeSignature(signature), object);
  }

  /**
   * Signs a proxy by which the chain's first authorizer stands behind
   * `target`. The signer has to be the chain's last agent, and each
   * authorization has to be signed by the agent of the one before it: a
   * reader counts no other proxy, so no other is signed.
   */
  async proxy(target: Link<EncodedObject>, chain: readonly Authorization[], signer: Signer): Promise<Signed> {
    checkChain(chain, signer.identity);
    const object = encodeObject(this.#proxy, { target, chain: chain.map(({ signature }) => signature.link) });
    return { object, signature: await sign(object, signer) };
  }

  /**
   * Reads how an identity stands behind `target` by one signature, `entry`,
   * at the reader's clock `now`. An entry over `target` is its signer's own;
   * an entry over a Proxy for `target` is the chain's first authorizer's,
   * through the chain's agents. The blobs the entry leads to are looked up in
   * `blobs` by link, and nothing else there is read. Throws when the entry
   * does not stand anyone behind `target`, saying why.
   */
  readStanding(target: Link<EncodedObject>, entry: Bytes<Signature>, blobs: Blobs, now: Date): Standing {
    const signature = decodeSignature(entry);
    if (signature.object === target) return { identity: signature.identity, agents: [] };
    const proxy = decodeObject(blobAt(blobs, signature.object), this.#proxy);
    const { target: named, chain: links } = proxy.data as ProxyData;
    if (named !== target) throw new Error(`the proxy is for ${named}, not ${target}`);
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const chain = links.map((link) => {
      const granted = decodeSignature(blobAt(blobs, link));
      const authorization = this.#authorizationFrom(granted, blobAt(blobs, granted.object));
      const until = endOf(authorization.object);
      if (until !== undefined && Temporal.Instant.compare(instant, until) >= 0) {
        throw new Error(`the authorization ${link} ended at ${until}`);
      }
      return authorization;
    });
    checkChain(chain, signature.identity);
    return { identity: chain[0].authorizer, agents: chain.map(({ agent }) => agent) };
  }

  #authorizationFrom(signature: Signature, bytes: Bytes<EncodedObject>): Authorization {
    return authorizationOf(decodeObject(bytes, this.#authorization), signature);
  }
}

export async function loadAuthorizations(validator: SchemaValidator): Promise<Authorizations> {
  const authorization = await encodeSchema(authorizationSchema, validator);
  const proxy = await encodeSchema(proxySchema, validator);
  return new Authorizations(authorization, proxy);
}

// Whether a validator asserts `format` is its own business, so an `until`
// can reach here that Temporal does not read as an instant. Such an
// authorization counts for no one, and is refused rather than signed or read.
function endOf(authorization: EncodedObject): Temporal.Instant | undefined {
  const { until } = authorization.data as AuthorizationData;
  return until === undefined ? undefined : Temporal.Instant.from(until);
}

function authorizationOf(object: EncodedObject, signature: Signature): Authorization {
  if (signature.object !== object.link) throw new Error(`the signature is over ${signature.object}, not ${object.link}`);
  endOf(object);
  const { agent } = object.data as AuthorizationData;
  return { object, signature, authorizer: signature.identity, agent: identityFromJson(agent) };
}

function checkChain(
  chain: readonly Authorization[],
  signer: Identity,
): asserts chain is readonly [Authorization, ...Authorization[]] {
  const last = chain.at(-1);
  if (last === undefined) throw new Error("a proxy names at least one authorization");
  if (!chain.every((authorization, i) => i === 0 || sameIdentity(chain[i - 1]!.agent, authorization.authorizer))) {
    throw new Error("each authorization in the chain has to be signed by the agent of the one before it");
  }
  if (!sameIdentity(last.agent, signer)) throw new Error("a proxy is signed by the last agent in its chain");
}

function blobAt<T>(blobs: Blobs, link: Link<T>): Bytes<T> {
  const bytes = blobs.get(link);
  if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
  if (linkOf(bytes) !== link) throw new Error(`the blob given for ${link} is another blob`);
  return bytes;
}
