import { sameIdentity, type Identity, type Signer } from "@estoc/identity";
import {
  encodeObject,
  encodeSchema,
  loadSignatures,
  readObject,
  type EncodedObject,
  type IdentityObject,
  type Json,
  type JsonLink,
  type JsonSchemaValidator,
  type Link,
  type Reader,
  type Schema,
  type Signature,
  type Signatures,
} from "@estoc/object";
// Temporal is not yet in every runtime this runs in, nor in the TypeScript lib.
import { Temporal } from "temporal-polyfill";
import { authorizationSchema, proxySchema } from "./schemas.ts";

export type AuthorizationData = { readonly agent: JsonLink<IdentityObject>; readonly until?: string };

/**
 * What an authorizer signs: it lets `agent` act for it in full, authorizing
 * others included, while the reader's clock is before `until` if there is one.
 */
export interface Authorization extends EncodedObject<Json, AuthorizationData> {
  readonly link: Link<Authorization>;
  readonly agent: IdentityObject;
  readonly until: Temporal.Instant | undefined;
}

export type ProxyData = { readonly target: JsonLink<never>; readonly chain: readonly JsonLink<Signature>[] };

/**
 * What an agent signs to stand behind `target` for someone else: `chain`
 * links the signatures over the authorizations that lead from them to the
 * agent, in order.
 */
export interface Proxy extends EncodedObject<Json, ProxyData> {
  readonly link: Link<Proxy>;
  readonly target: Link<never>;
  readonly chain: readonly Link<Signature>[];
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
  readonly identity: IdentityObject;
  readonly agents: readonly IdentityObject[];
}

/**
 * Authorizations and proxies, read and written with the schemas compiled
 * once by one validator, as are the `signatures` over them. What a reading
 * leads to is got by link from the reader it is given, as it is needed.
 */
export class Authorizations {
  readonly signatures: Signatures;
  readonly #authorization: Schema<Json, AuthorizationData>;
  readonly #proxy: Schema<Json, ProxyData>;

  constructor(signatures: Signatures, authorization: Schema<Json, AuthorizationData>, proxy: Schema<Json, ProxyData>) {
    this.signatures = signatures;
    this.#authorization = authorization;
    this.#proxy = proxy;
  }

  /** Signs an authorization that lets `agent` act for the signer, until the instant `until` if one is given. */
  async authorize(agent: Identity, signer: Signer, until?: Temporal.Instant): Promise<Signed<Authorization>> {
    const named = this.signatures.identities.encode(agent);
    const data = { agent: { $link: named.link } };
    // An instant past the year 9999 has no RFC 3339 `date-time`, so a
    // validator that asserts `format` refuses it here, before the signer is
    // asked, which may be a wallet prompting its holder.
    const written = encodeObject(this.#authorization, until === undefined ? data : { ...data, until: until.toString() });
    const object = await this.#readAuthorization(written, new Map([[named.link, named.bytes]]));
    return { object, signature: await this.signatures.sign(object, signer) };
  }

  /**
   * Reads an authorization by the signature over it, `entry`, from `reader`,
   * which holds the signature, the authorization and the objects of both
   * identities.
   */
  async readAuthorization(entry: Link<Signature>, reader: Reader): Promise<Signed<Authorization>> {
    return this.#signedAuthorization(await this.signatures.read(entry, reader), reader);
  }

  /**
   * Signs a proxy by which the chain's first authorizer stands behind
   * `target`. The signer has to be the chain's last agent, and each
   * authorization has to be signed by the agent of the one before it: a
   * reader counts no other proxy, so no other is signed.
   */
  async proxy(target: Link<unknown>, chain: readonly Signed<Authorization>[], signer: Signer): Promise<Signed<Proxy>> {
    checkChain(chain, signer.identity);
    const data = { target: { $link: target as Link<never> }, chain: chain.map(({ signature }) => ({ $link: signature.link })) };
    const object = readProxy(encodeObject(this.#proxy, data));
    return { object, signature: await this.signatures.sign(object, signer) };
  }

  /**
   * Reads how an identity stands behind `target` by one signature, `entry`,
   * at the reader's clock `now`. An entry over `target` is its signer's own;
   * an entry over a Proxy for `target` is the chain's first authorizer's,
   * through the chain's agents. The entry and what it leads to are got from
   * `reader` by link, and nothing else there is read. Throws when the entry
   * does not stand anyone behind `target`, saying why.
   */
  async readStanding(target: Link<unknown>, entry: Link<Signature>, reader: Reader, now: Date): Promise<Standing> {
    const signature = await this.signatures.read(entry, reader);
    if (signature.object === target) return { identity: signature.identity, agents: [] };
    const proxy = readProxy(await readObject(reader, signature.object, this.#proxy));
    if (proxy.target !== target) throw new Error(`the proxy is for ${proxy.target}, not ${target}`);
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const chain: Signed<Authorization>[] = [];
    for (const link of proxy.chain) {
      const authorization = await this.#signedAuthorization(await this.signatures.read(link, reader), reader);
      const { until } = authorization.object;
      if (until !== undefined && Temporal.Instant.compare(instant, until) >= 0) {
        throw new Error(`the authorization ${link} ended at ${until}`);
      }
      chain.push(authorization);
    }
    checkChain(chain, signature.identity);
    return { identity: chain[0].signature.identity, agents: chain.map(({ object }) => object.agent) };
  }

  async #signedAuthorization(signature: Signature, reader: Reader): Promise<Signed<Authorization>> {
    return { object: await this.#readAuthorization(await readObject(reader, signature.object, this.#authorization), reader), signature };
  }

  async #readAuthorization(object: EncodedObject<Json, AuthorizationData>, reader: Reader): Promise<Authorization> {
    const { agent, until } = object.data;
    // Whether a validator asserts `format` is its own business, so an `until`
    // can reach here that Temporal does not read as an instant. Such an
    // authorization counts for no one, and is refused.
    const end = until === undefined ? undefined : Temporal.Instant.from(until);
    const { identities } = this.signatures;
    const identity = identities.read(await readObject(reader, agent.$link, identities.schema));
    return { ...object, link: object.link as Link<Authorization>, agent: identity, until: end };
  }
}

function readProxy(object: EncodedObject<Json, ProxyData>): Proxy {
  const { target, chain } = object.data;
  return { ...object, link: object.link as Link<Proxy>, target: target.$link, chain: chain.map(({ $link }) => $link) };
}

export async function loadAuthorizations(validator: JsonSchemaValidator): Promise<Authorizations> {
  const signatures = await loadSignatures(validator);
  return new Authorizations(signatures, await encodeSchema(authorizationSchema, validator), await encodeSchema(proxySchema, validator));
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
