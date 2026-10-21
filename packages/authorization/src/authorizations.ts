import { identityFromJson, identityToJson, sameIdentity, type Identity, type IdentityJson, type Signer } from "@estoc/identity";
import {
  encodeSchema,
  linkOf,
  reading,
  sign,
  signatures,
  View,
  type Bytes,
  type Link,
  type Schema,
  type SchemaValidator,
  type Signature,
} from "@estoc/object";
// Temporal is not yet in every runtime this runs in, nor in the TypeScript lib.
import { Temporal } from "temporal-polyfill";
import { authorizationSchema, proxySchema } from "./schemas.ts";

/**
 * What an authorizer signs: it lets `agent` act for it in full, authorizing
 * others included, while the reader's clock is before `until` if there is one.
 */
export interface Authorization {
  readonly agent: Identity;
  readonly until: Temporal.Instant | undefined;
  readonly bytes: Bytes<Authorization>;
  readonly link: Link<Authorization>;
}

/**
 * What an agent signs to stand behind `target` for someone else: `chain`
 * links the signatures over the authorizations that lead from them to the
 * agent, in order.
 */
export interface Proxy {
  readonly target: Link<never>;
  readonly chain: readonly Link<Signature>[];
  readonly bytes: Bytes<Proxy>;
  readonly link: Link<Proxy>;
}

/** An object and one signature over it. */
export interface Signed<T> {
  readonly object: T;
  readonly signature: Signature;
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
type ProxyData = { readonly target: Link<never>; readonly chain: readonly Link<Signature>[] };

/** Authorizations and proxies, read and written with the schemas compiled once by one validator. */
export class Authorizations {
  readonly #authorizationSchema: Link<Schema>;
  readonly #proxySchema: Link<Schema>;
  readonly #authorizations: View<Authorization>;
  readonly #proxies: View<Proxy>;

  constructor(authorization: Schema, proxy: Schema) {
    this.#authorizationSchema = authorization.link;
    this.#proxySchema = proxy.link;
    this.#authorizations = new View([
      reading(authorization, (data, object) => {
        const { agent, until } = data as AuthorizationData;
        // Whether a validator asserts `format` is its own business, so an
        // `until` can reach here that Temporal does not read as an instant.
        // Such an authorization counts for no one, and is refused rather than
        // signed or read.
        return { agent: identityFromJson(agent), until: until === undefined ? undefined : Temporal.Instant.from(until), ...object };
      }),
    ]);
    this.#proxies = new View([
      reading(proxy, (data, object) => {
        const { target, chain } = data as ProxyData;
        return { target, chain, ...object };
      }),
    ]);
  }

  /**
   * Signs an authorization that lets `agent` act for the signer, until the
   * RFC 3339 `date-time` `until` if one is given.
   */
  async authorize(agent: Identity, signer: Signer, until?: string): Promise<Signed<Authorization>> {
    // An `until` that does not read is refused here, before the signer is
    // asked, which may be a wallet prompting its holder.
    const object = this.#authorizations.encode(
      this.#authorizationSchema,
      until === undefined ? { agent: identityToJson(agent) } : { agent: identityToJson(agent), until },
    );
    return { object, signature: await sign(object, signer) };
  }

  /** Reads an authorization from the blobs of its signature and its object. */
  readAuthorization(signature: Bytes<Signature>, object: Bytes<Authorization>): Signed<Authorization> {
    return signedOver(this.#authorizations.decode(object), signatures.decode(signature));
  }

  /**
   * Signs a proxy by which the chain's first authorizer stands behind
   * `target`. The signer has to be the chain's last agent, and each
   * authorization has to be signed by the agent of the one before it: a
   * reader counts no other proxy, so no other is signed.
   */
  async proxy(target: Link<unknown>, chain: readonly Signed<Authorization>[], signer: Signer): Promise<Signed<Proxy>> {
    checkChain(chain, signer.identity);
    const object = this.#proxies.encode(this.#proxySchema, { target, chain: chain.map(({ signature }) => signature.link) });
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
  readStanding(target: Link<unknown>, entry: Bytes<Signature>, blobs: Blobs, now: Date): Standing {
    const signature = signatures.decode(entry);
    if (signature.object === target) return { identity: signature.identity, agents: [] };
    const proxy = this.#proxies.decode(blobAt(blobs, signature.object));
    if (proxy.target !== target) throw new Error(`the proxy is for ${proxy.target}, not ${target}`);
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const chain = proxy.chain.map((link) => {
      const granted = signatures.decode(blobAt(blobs, link));
      const authorization = signedOver(this.#authorizations.decode(blobAt(blobs, granted.object)), granted);
      const { until } = authorization.object;
      if (until !== undefined && Temporal.Instant.compare(instant, until) >= 0) {
        throw new Error(`the authorization ${link} ended at ${until}`);
      }
      return authorization;
    });
    checkChain(chain, signature.identity);
    return { identity: chain[0].signature.identity, agents: chain.map(({ object }) => object.agent) };
  }
}

export async function loadAuthorizations(validator: SchemaValidator): Promise<Authorizations> {
  const authorization = await encodeSchema(authorizationSchema, validator);
  const proxy = await encodeSchema(proxySchema, validator);
  return new Authorizations(authorization, proxy);
}

function signedOver<T extends { readonly link: Link<unknown> }>(object: T, signature: Signature): Signed<T> {
  if (signature.object !== object.link) throw new Error(`the signature is over ${signature.object}, not ${object.link}`);
  return { object, signature };
}

function checkChain(
  chain: readonly Signed<Authorization>[],
  signer: Identity,
): asserts chain is readonly [Signed<Authorization>, ...Signed<Authorization>[]] {
  const last = chain.at(-1);
  if (last === undefined) throw new Error("a proxy names at least one authorization");
  if (!chain.every(({ signature }, i) => i === 0 || sameIdentity(chain[i - 1]!.object.agent, signature.identity))) {
    throw new Error("each authorization in the chain has to be signed by the agent of the one before it");
  }
  if (!sameIdentity(last.object.agent, signer)) throw new Error("a proxy is signed by the last agent in its chain");
}

function blobAt<T>(blobs: Blobs, link: Link<T>): Bytes<T> {
  const bytes = blobs.get(link);
  if (bytes === undefined) throw new Error(`no blob is given for ${link}`);
  if (linkOf(bytes) !== link) throw new Error(`the blob given for ${link} is another blob`);
  return bytes;
}
