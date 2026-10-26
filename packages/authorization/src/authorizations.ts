import { type Identity, type Signer, sameIdentity } from "@estoc/identity";
import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type IdentityObject,
  type Json,
  type JsonLink,
  type JsonSchemaValidator,
  type Link,
  loadSignatures,
  type Reader,
  readObject,
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
interface Proxy extends EncodedObject<Json, ProxyData> {
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
 * One way `principal` stands behind an object: by its own signature when
 * `agents` is empty, or else through these agents, in order from the one it
 * authorized to the one that signed the proxy.
 */
export interface Standing {
  readonly principal: IdentityObject;
  readonly agents: readonly IdentityObject[];
}

/**
 * A signature by which an identity stands behind an object, and the blobs it
 * leads to, each once: what a reading of it takes besides the signature
 * itself. The object is only named, and is not among them.
 */
export interface Entry {
  readonly signature: Signature;
  readonly blobs: readonly Bytes<unknown>[];
}

/**
 * Authorizations and proxies, read and written with the schemas compiled
 * once by one validator, as are the `signatures` over them. What a reading
 * leads to is got by link from the reader it is given, as it is needed.
 */
export class Authorizations {
  readonly signatures: Signatures;
  readonly #authorizationSchema: Schema<Json, AuthorizationData>;
  readonly #proxySchema: Schema<Json, ProxyData>;

  constructor(signatures: Signatures, authorization: Schema<Json, AuthorizationData>, proxy: Schema<Json, ProxyData>) {
    this.signatures = signatures;
    this.#authorizationSchema = authorization;
    this.#proxySchema = proxy;
  }

  /** Signs an authorization that lets `agent` act for the signer, until the instant `until` if one is given. */
  async authorize(agent: Identity, signer: Signer, until?: Temporal.Instant): Promise<Signed<Authorization>> {
    const identity = this.signatures.identities.encode(agent);
    const data = { agent: { $link: identity.link } };
    // An instant past the year 9999 has no RFC 3339 `date-time`, so a
    // validator that asserts `format` refuses it here, before the signer is
    // asked, which may be a wallet prompting its holder.
    const written = encodeObject(
      this.#authorizationSchema,
      until === undefined ? data : { ...data, until: until.toString() },
    );
    const object = await this.#checkAuthorization(written, new Map([[identity.link, identity.bytes]]));
    return { object, signature: await this.signatures.sign(object, signer) };
  }

  /**
   * Reads an authorization by the link of the signature over it from
   * `reader`, which holds the signature, the authorization and the objects of
   * both identities.
   */
  async readAuthorization(link: Link<Signature>, reader: Reader): Promise<Signed<Authorization>> {
    const signature = await this.signatures.read(link, reader);
    const object = await this.#checkAuthorization(
      await readObject(reader, signature.object, this.#authorizationSchema),
      reader,
    );
    return { object, signature };
  }

  /**
   * An actor for the signer's own identity, which signs what it stands
   * behind, or with `chain`, for the chain's first authorizer, with the signer
   * signing proxies as the chain's last agent. Refuses a chain in which an
   * authorization is not signed by the agent of the one before it, or that
   * does not end at the signer: a reader counts no other proxy.
   */
  createActor(signer: Signer, chain: readonly Signed<Authorization>[] = []): Actor {
    return new Actor(this.signatures, this.#proxySchema, signer, chain);
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
    if (signature.object === target) return { principal: signature.identity, agents: [] };
    const proxy = proxyOf(await readObject(reader, signature.object, this.#proxySchema));
    if (proxy.target !== target) throw new Error(`the proxy is for ${proxy.target}, not ${target}`);
    const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
    const chain: Signed<Authorization>[] = [];
    for (const link of proxy.chain) {
      const authorization = await this.readAuthorization(link, reader);
      const { until } = authorization.object;
      if (until !== undefined && Temporal.Instant.compare(instant, until) >= 0) {
        throw new Error(`the authorization ${link} ended at ${until}`);
      }
      chain.push(authorization);
    }
    checkChain(chain, signature.identity);
    return { principal: chain[0].signature.identity, agents: chain.map(({ object }) => object.agent) };
  }

  async #checkAuthorization(object: EncodedObject<Json, AuthorizationData>, reader: Reader): Promise<Authorization> {
    const { agent, until } = object.data;
    // Whether a validator asserts `format` is its own business, so an `until`
    // can reach here that Temporal does not read as an instant. Such an
    // authorization counts for no one, and is refused.
    const end = until === undefined ? undefined : Temporal.Instant.from(until);
    const identity = await this.signatures.identities.read(agent.$link, reader);
    return { ...object, link: object.link as Link<Authorization>, agent: identity, until: end };
  }
}

/**
 * A signer standing behind objects for `principal`, through `agents`, as a
 * reading of what it signs gives while the chain holds: itself with no agents,
 * or a chain's first authorizer through the chain's agents, the signer being
 * the last of them.
 */
export class Actor implements Standing {
  readonly principal: IdentityObject;
  readonly agents: readonly IdentityObject[];
  readonly #signatures: Signatures;
  readonly #proxySchema: Schema<Json, ProxyData>;
  readonly #signer: Signer;
  readonly #chain: readonly Signed<Authorization>[];

  constructor(
    signatures: Signatures,
    proxy: Schema<Json, ProxyData>,
    signer: Signer,
    chain: readonly Signed<Authorization>[],
  ) {
    const [first] = chain;
    if (first === undefined) {
      this.principal = signatures.identities.encode(signer.identity);
      this.agents = [];
    } else {
      checkChain(chain, signer.identity);
      this.principal = first.signature.identity;
      this.agents = chain.map(({ object }) => object.agent);
    }
    this.#signatures = signatures;
    this.#proxySchema = proxy;
    this.#signer = signer;
    this.#chain = chain;
  }

  /**
   * Signs for the principal behind `target`: the target itself, or a proxy
   * for it. The target is only named. No clock is looked at, since whether
   * the chain holds is for the reader's clock to say.
   */
  async sign(target: Link<unknown>): Promise<Entry> {
    if (this.#chain.length === 0) {
      const signature = await this.#signatures.sign({ link: target }, this.#signer);
      return { signature, blobs: [signature.identity.bytes] };
    }
    const data = {
      target: { $link: target as Link<never> },
      chain: this.#chain.map(({ signature }) => ({ $link: signature.link })),
    };
    const proxy = encodeObject(this.#proxySchema, data);
    const signature = await this.#signatures.sign(proxy, this.#signer);
    const chain = this.#chain.flatMap(({ object, signature }) => [signature, signature.identity, object, object.agent]);
    const blobs = new Map([signature.identity, proxy, ...chain].map(({ link, bytes }) => [link, bytes]));
    return { signature, blobs: [...blobs.values()] };
  }
}

function proxyOf(object: EncodedObject<Json, ProxyData>): Proxy {
  const { target, chain } = object.data;
  return { ...object, link: object.link as Link<Proxy>, target: target.$link, chain: chain.map(({ $link }) => $link) };
}

export async function loadAuthorizations(validator: JsonSchemaValidator): Promise<Authorizations> {
  const signatures = await loadSignatures(validator);
  return new Authorizations(
    signatures,
    await encodeSchema(authorizationSchema, validator),
    await encodeSchema(proxySchema, validator),
  );
}

function checkChain(
  chain: readonly Signed<Authorization>[],
  signer: Identity,
): asserts chain is readonly [Signed<Authorization>, ...Signed<Authorization>[]] {
  const last = chain.at(-1);
  if (last === undefined) throw new Error("a proxy names at least one authorization");
  const linked = chain.every(({ object }, i) => {
    const next = chain[i + 1];
    return next === undefined || sameIdentity(object.agent, next.signature.identity);
  });
  if (!linked) throw new Error("each authorization in the chain has to be signed by the agent of the one before it");
  if (!sameIdentity(last.object.agent, signer)) throw new Error("a proxy is signed by the last agent in its chain");
}
