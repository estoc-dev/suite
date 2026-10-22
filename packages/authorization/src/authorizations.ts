import { sameIdentity, type Identity, type Signer } from "@estoc/identity";
import {
  encodeSchema,
  loadSignatures,
  Semantics,
  type Blobs,
  type Bytes,
  type IdentityObject,
  type Json,
  type JsonSchemaValidator,
  type Link,
  type Schema,
  type Signature,
  type Signatures,
} from "@estoc/object";
// Temporal is not yet in every runtime this runs in, nor in the TypeScript lib.
import { Temporal } from "temporal-polyfill";
import { authorizationSchema, proxySchema } from "./schemas.ts";

/**
 * What an authorizer signs: it lets `agent` act for it in full, authorizing
 * others included, while the reader's clock is before `until` if there is one.
 */
export interface Authorization {
  readonly agent: IdentityObject;
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
  readonly identity: IdentityObject;
  readonly agents: readonly IdentityObject[];
}

type AuthorizationData = { readonly agent: Link<IdentityObject>; readonly until?: string };
type ProxyData = { readonly target: Link<never>; readonly chain: readonly Link<Signature>[] };

/**
 * Authorizations and proxies, read and written with the schemas compiled
 * once by one validator, as are the `signatures` over them.
 */
export class Authorizations {
  readonly signatures: Signatures;
  readonly #authorizations: Semantics<Authorization, Json, Pick<Authorization, "agent" | "until">>;
  readonly #proxies: Semantics<Proxy, Json, { readonly target: Link<unknown>; readonly chain: readonly Link<Signature>[] }>;

  constructor(signatures: Signatures, authorization: Schema<Json>, proxy: Schema<Json>) {
    this.signatures = signatures;
    this.#authorizations = new Semantics(
      [
        {
          schema: authorization,
          read(data, object, blobs) {
            const { agent, until } = data as AuthorizationData;
            // Whether a validator asserts `format` is its own business, so an
            // `until` can reach here that Temporal does not read as an instant.
            // Such an authorization counts for no one, and is refused.
            const end = until === undefined ? undefined : Temporal.Instant.from(until);
            return { agent: signatures.identities.follow(agent, blobs), until: end, ...object };
          },
        },
      ],
      {
        schema: authorization.link,
        write: ({ agent, until }) => (until === undefined ? { agent: agent.link } : { agent: agent.link, until: until.toString() }),
      },
    );
    this.#proxies = new Semantics(
      [
        {
          schema: proxy,
          read(data, object) {
            const { target, chain } = data as ProxyData;
            return { target, chain, ...object };
          },
        },
      ],
      { schema: proxy.link, write: ({ target, chain }) => ({ target, chain }) },
    );
  }

  /** Signs an authorization that lets `agent` act for the signer, until the instant `until` if one is given. */
  async authorize(agent: Identity, signer: Signer, until?: Temporal.Instant): Promise<Signed<Authorization>> {
    const named = this.signatures.identities.encode(agent);
    // An instant past the year 9999 has no RFC 3339 `date-time`, so a
    // validator that asserts `format` refuses it here, before the signer is
    // asked, which may be a wallet prompting its holder.
    const object = this.#authorizations.encode({ agent: named, until }, new Map([[named.link, named.bytes]]));
    return { object, signature: await this.signatures.sign(object, signer) };
  }

  /**
   * Reads an authorization by the signature over it, `entry`, from the blobs
   * it leads to: the authorization and the objects of both identities.
   */
  readAuthorization(entry: Bytes<Signature>, blobs: Blobs): Signed<Authorization> {
    return this.#signedAuthorization(this.signatures.decode(entry, blobs), blobs);
  }

  /**
   * Signs a proxy by which the chain's first authorizer stands behind
   * `target`. The signer has to be the chain's last agent, and each
   * authorization has to be signed by the agent of the one before it: a
   * reader counts no other proxy, so no other is signed.
   */
  async proxy(target: Link<unknown>, chain: readonly Signed<Authorization>[], signer: Signer): Promise<Signed<Proxy>> {
    checkChain(chain, signer.identity);
    const object = this.#proxies.encode({ target, chain: chain.map(({ signature }) => signature.link) });
    return { object, signature: await this.signatures.sign(object, signer) };
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
    const signature = this.signatures.decode(entry, blobs);
    if (signature.object === target) return { identity: signature.identity, agents: [] };
    const proxy = this.#proxies.follow(signature.object, blobs);
    if (proxy.target !== target) throw new Error(`the proxy is for ${proxy.target}, not ${target}`);
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const chain = proxy.chain.map((link) => {
      const authorization = this.#signedAuthorization(this.signatures.follow(link, blobs), blobs);
      const { until } = authorization.object;
      if (until !== undefined && Temporal.Instant.compare(instant, until) >= 0) {
        throw new Error(`the authorization ${link} ended at ${until}`);
      }
      return authorization;
    });
    checkChain(chain, signature.identity);
    return { identity: chain[0].signature.identity, agents: chain.map(({ object }) => object.agent) };
  }

  #signedAuthorization(signature: Signature, blobs: Blobs): Signed<Authorization> {
    return { object: this.#authorizations.follow(signature.object, blobs), signature };
  }
}

export async function loadAuthorizations(validator: JsonSchemaValidator): Promise<Authorizations> {
  const signatures = await loadSignatures(validator);
  const authorization = await encodeSchema(authorizationSchema, validator);
  const proxy = await encodeSchema(proxySchema, validator);
  return new Authorizations(signatures, authorization, proxy);
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
