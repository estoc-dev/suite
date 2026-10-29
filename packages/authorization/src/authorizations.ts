import {
  type IdentityObject,
  type Key,
  loadSignatures,
  type Signature,
  type Signatures,
  type Signer,
} from "@estoc/identity";
import {
  type Bytes,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonLink,
  type JsonSchemaValidator,
  type Link,
  linkOf,
  type Reader,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { authorizationSchema, proxySchema } from "./schemas.ts";

export type AuthorizationData = { readonly agent: JsonLink<IdentityObject> };

/**
 * What an authorizer signs: it lets `agent` act for it in full, authorizing
 * others included.
 */
export interface Authorization extends EncodedObject<Json, AuthorizationData> {
  readonly link: Link<Authorization>;
  readonly agent: IdentityObject;
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

  /** Signs an authorization that lets the identity whose root is `agent` act for the signer. */
  async authorize(agent: Key, signer: Signer): Promise<Signed<Authorization>> {
    const identity = this.signatures.identities.encode(agent);
    const written = encodeObject(this.#authorizationSchema, { agent: { $link: identity.link } });
    const object = await this.#checkAuthorization(written, byLink(identity.blobs));
    return { object, signature: await this.signatures.sign(object, signer) };
  }

  /**
   * Reads an authorization by the link of the signature over it from
   * `reader`, which holds the signature, the authorization and the blobs of
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
   * as `readEntry` reads it, and throws unless the entry is for `target`.
   */
  async readStanding(target: Link<unknown>, entry: Link<Signature>, reader: Reader): Promise<Standing> {
    const { target: read, ...standing } = await this.readEntry(entry, reader);
    if (read !== target) throw new Error(`the entry is for ${read}, not ${target}`);
    return standing;
  }

  /**
   * Reads which object one signature, `entry`, stands an identity behind, and
   * how. An entry over a Proxy stands the chain's first authorizer behind the
   * Proxy's target, through the chain's agents; an entry over any other
   * object stands its signer behind it. The entry and what it leads to are
   * got from `reader` by link, and nothing else there is read. The object is
   * only named, so a reader that does not know it reads it by `target`, with
   * the schema it expects. Throws when the entry stands no one behind
   * anything, saying why.
   */
  async readEntry(entry: Link<Signature>, reader: Reader): Promise<Standing & { readonly target: Link<never> }> {
    const signature = await this.signatures.read(entry, reader);
    if (!(await this.#isProxy(signature.object, reader))) {
      return { target: signature.object, principal: signature.identity, agents: [] };
    }
    const proxy = proxyOf(await readObject(reader, signature.object, this.#proxySchema));
    const chain: Signed<Authorization>[] = [];
    for (const link of proxy.chain) chain.push(await this.readAuthorization(link, reader));
    checkChain(chain, signature.identity.link);
    return {
      target: proxy.target,
      principal: chain[0].signature.identity,
      agents: chain.map(({ object }) => object.agent),
    };
  }

  // A Proxy that the reader does not hold cannot be told from any other
  // object, so the entry reads as its signer's own over the Proxy's link.
  async #isProxy(link: Link<unknown>, reader: Reader): Promise<boolean> {
    const bytes = await reader.get(link);
    if (bytes === undefined) return false;
    try {
      return schemaOf(bytes, this.#proxySchema.encoding) === this.#proxySchema.link;
    } catch {
      return false;
    }
  }

  async #checkAuthorization(object: EncodedObject<Json, AuthorizationData>, reader: Reader): Promise<Authorization> {
    const identity = await this.signatures.identities.read(object.data.agent.$link, reader);
    return { ...object, link: object.link as Link<Authorization>, agent: identity };
  }
}

/**
 * A signer standing behind objects for `principal`, through `agents`, as a
 * reading of what it signs gives: itself with no agents, or a chain's first
 * authorizer through the chain's agents, the signer being the last of them.
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
      this.principal = signatures.identities.encode(signer.key);
      this.agents = [];
    } else {
      checkChain(chain, signatures.identities.encode(signer.key).link);
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
   * for it. The target is only named.
   */
  async sign(target: Link<unknown>): Promise<Entry> {
    if (this.#chain.length === 0) {
      const signature = await this.#signatures.sign({ link: target }, this.#signer);
      return { signature, blobs: signature.identity.blobs };
    }
    const data = {
      target: { $link: target as Link<never> },
      chain: this.#chain.map(({ signature }) => ({ $link: signature.link })),
    };
    const proxy = encodeObject(this.#proxySchema, data);
    const signature = await this.#signatures.sign(proxy, this.#signer);
    const chain = this.#chain.flatMap(({ object, signature }) => [
      signature.bytes,
      ...signature.identity.blobs,
      object.bytes,
      ...object.agent.blobs,
    ]);
    return { signature, blobs: [...byLink([...signature.identity.blobs, proxy.bytes, ...chain]).values()] };
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

function byLink(blobs: readonly Uint8Array[]): Map<Link<unknown>, Uint8Array> {
  return new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));
}

function checkChain(
  chain: readonly Signed<Authorization>[],
  signer: Link<IdentityObject>,
): asserts chain is readonly [Signed<Authorization>, ...Signed<Authorization>[]] {
  const last = chain.at(-1);
  if (last === undefined) throw new Error("a proxy names at least one authorization");
  const linked = chain.every(({ object }, i) => {
    const next = chain[i + 1];
    return next === undefined || object.agent.link === next.signature.identity.link;
  });
  if (!linked) throw new Error("each authorization in the chain has to be signed by the agent of the one before it");
  if (last.object.agent.link !== signer) throw new Error("a proxy is signed by the last agent in its chain");
}
