import { identityFromJson, identityToJson, sameIdentity, type Identity, type IdentityJson, type Signer } from "@estoc/identity";
import {
  decodeObject,
  decodeSignature,
  encodeObject,
  encodeSchema,
  linkOf,
  sign,
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

/**
 * Where a reading finds blobs: a store and its index, neither of which is
 * part of the format. The index only offers candidates and the reading
 * checks each one, so an index that offers too much changes nothing.
 */
export interface Evidence {
  blob(link: Link<unknown>): Uint8Array | undefined;
  signaturesOver(link: Link<EncodedObject>): Iterable<Signature>;
  proxiesFor(link: Link<EncodedObject>): Iterable<EncodedObject>;
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
  readAuthorization(signature: Uint8Array, object: Uint8Array): Authorization {
    return this.#authorizationFrom(decodeSignature(signature), object);
  }

  /**
   * Signs a proxy by which the chain's first authorizer stands behind
   * `target`. The signer has to be the chain's last agent, and each
   * authorization has to be signed by the agent of the one before it: a
   * reader counts no other proxy, so no other is signed.
   */
  async proxy(target: Link<EncodedObject>, chain: readonly Authorization[], signer: Signer): Promise<Signed> {
    const last = chain.at(-1);
    if (last === undefined) throw new Error("a proxy names at least one authorization");
    if (!connects(chain)) throw new Error("each authorization in the chain has to be signed by the agent of the one before it");
    if (!sameIdentity(last.agent, signer.identity)) throw new Error("a proxy is signed by the last agent in its chain");
    const object = encodeObject(this.#proxy, { target, chain: chain.map(({ signature }) => signature.link) });
    return { object, signature: await sign(object, signer) };
  }

  /**
   * Evidence held in memory: every blob by its link, signatures by the
   * object they are over, and proxies by their target. A blob that is
   * neither a signature nor a proxy is kept by its link alone.
   */
  evidenceFrom(blobs: Iterable<Uint8Array>): Evidence {
    const byLink = new Map<string, Uint8Array>();
    const signatures = new Map<string, Signature[]>();
    const proxies = new Map<string, EncodedObject[]>();
    for (const blob of blobs) {
      const bytes = new Uint8Array(blob);
      const link = linkOf(bytes);
      if (byLink.has(link)) continue;
      byLink.set(link, bytes);
      const signature = attempt(() => decodeSignature(bytes));
      if (signature !== undefined) append(signatures, signature.object, signature);
      const proxy = attempt(() => decodeObject(bytes, this.#proxy));
      if (proxy !== undefined) append(proxies, (proxy.data as ProxyData).target, proxy);
    }
    return {
      blob: (link) => byLink.get(link),
      signaturesOver: (link) => signatures.get(link) ?? [],
      proxiesFor: (link) => proxies.get(link) ?? [],
    };
  }

  /**
   * Every way an identity stands behind `target` by the reader's clock
   * `now`, each listed once. A way that misses a blob, or has one that does
   * not read, is left out and the others still count; at the same `now`,
   * more evidence only adds to the list.
   */
  standingBehind(target: Link<EncodedObject>, evidence: Evidence, now: Date): Standing[] {
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const standings: Standing[] = [];
    const add = (standing: Standing) => {
      if (!standings.some((other) => sameStanding(other, standing))) standings.push(standing);
    };
    for (const identity of signersOf(target, evidence)) add({ identity, agents: [] });
    for (const proxy of evidence.proxiesFor(target)) {
      const standing = this.#standingThrough(proxy, target, evidence, instant);
      if (standing !== undefined) add(standing);
    }
    return standings;
  }

  #standingThrough(
    proxy: EncodedObject,
    target: Link<EncodedObject>,
    evidence: Evidence,
    now: Temporal.Instant,
  ): Standing | undefined {
    if (proxy.schema.link !== this.#proxy.link) return undefined;
    const { target: named, chain: links } = proxy.data as ProxyData;
    if (named !== target) return undefined;
    const chain: Authorization[] = [];
    for (const link of links) {
      const authorization = this.#authorizationAt(link, evidence);
      if (authorization === undefined || !inForce(authorization, now)) return undefined;
      chain.push(authorization);
    }
    const [first] = chain;
    const last = chain.at(-1);
    if (first === undefined || last === undefined || !connects(chain)) return undefined;
    if (!signersOf(proxy.link, evidence).some((identity) => sameIdentity(identity, last.agent))) return undefined;
    return { identity: first.authorizer, agents: chain.map(({ agent }) => agent) };
  }

  #authorizationAt(link: Link<Signature>, evidence: Evidence): Authorization | undefined {
    const signatureBytes = evidence.blob(link);
    const signature = signatureBytes && attempt(() => decodeSignature(signatureBytes));
    if (signature?.link !== link) return undefined;
    const objectBytes = evidence.blob(signature.object);
    return objectBytes && attempt(() => this.#authorizationFrom(signature, objectBytes));
  }

  #authorizationFrom(signature: Signature, bytes: Uint8Array): Authorization {
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

function inForce(authorization: Authorization, now: Temporal.Instant): boolean {
  const until = endOf(authorization.object);
  return until === undefined || Temporal.Instant.compare(now, until) < 0;
}

function connects(chain: readonly Authorization[]): boolean {
  return chain.every((authorization, i) => i === 0 || sameIdentity(chain[i - 1]!.agent, authorization.authorizer));
}

function signersOf(link: Link<EncodedObject>, evidence: Evidence): Identity[] {
  return [...evidence.signaturesOver(link)].filter(({ object }) => object === link).map(({ identity }) => identity);
}

function sameStanding(a: Standing, b: Standing): boolean {
  return (
    sameIdentity(a.identity, b.identity) &&
    a.agents.length === b.agents.length &&
    a.agents.every((agent, i) => sameIdentity(agent, b.agents[i]!))
  );
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function append<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else values.push(value);
}
