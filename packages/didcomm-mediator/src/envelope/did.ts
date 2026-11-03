import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { base64url, fromBase64url, isObject, type JsonObject, parseObject, textOf, utf8 } from "./encoding.ts";
import {
  type CurveName,
  multibaseOf,
  type NamedKey,
  type PublicKey,
  publicKey,
  publicKeyFromJwk,
  publicKeyFromMultibase,
  x25519KeyOf,
} from "./keys.ts";

/**
 * A resolved DID document. It is read defensively: what a peer DID holds
 * came from whoever made the DID.
 */
export interface DidDocument extends JsonObject {
  readonly id: string;
}

export type Relationship =
  | "authentication"
  | "assertionMethod"
  | "keyAgreement"
  | "capabilityInvocation"
  | "capabilityDelegation";

export interface DidResolver {
  /** The document of `did`, or undefined when it does not resolve here. */
  resolve(did: string): Promise<DidDocument | undefined>;
}

/** The DID of a DID URL: what comes before its path, query or fragment. */
export function didOf(didUrl: string): string {
  const end = didUrl.search(/[/?#]/);
  return end === -1 ? didUrl : didUrl.slice(0, end);
}

function absolute(did: string, reference: string): string {
  return reference.startsWith("#") ? `${did}${reference}` : reference;
}

const base58Types = new Map<string, CurveName>([
  ["Ed25519VerificationKey2018", "Ed25519"],
  ["X25519KeyAgreementKey2019", "X25519"],
]);

function keyOfMethod(method: JsonObject): PublicKey | undefined {
  if (typeof method.publicKeyMultibase === "string") return publicKeyFromMultibase(method.publicKeyMultibase);
  if (method.publicKeyJwk !== undefined) return publicKeyFromJwk(method.publicKeyJwk);
  const curve = typeof method.type === "string" ? base58Types.get(method.type) : undefined;
  if (curve !== undefined && typeof method.publicKeyBase58 === "string") {
    return publicKey(curve, base58.decode(method.publicKeyBase58));
  }
  return undefined;
}

/**
 * The keys of a verification relationship, each named by its absolute DID
 * URL. A method given by reference is looked up among the document's own;
 * one that cannot be read is passed over.
 */
export function keysOf(document: DidDocument, relationship: Relationship): NamedKey[] {
  const entries = document[relationship];
  if (!Array.isArray(entries)) return [];
  const methods = Array.isArray(document.verificationMethod) ? document.verificationMethod.filter(isObject) : [];
  const keys: NamedKey[] = [];
  for (const entry of entries) {
    const method =
      typeof entry === "string"
        ? methods.find(
            (candidate) =>
              typeof candidate.id === "string" && absolute(document.id, candidate.id) === absolute(document.id, entry),
          )
        : isObject(entry)
          ? entry
          : undefined;
    if (method === undefined || typeof method.id !== "string") continue;
    try {
      const key = keyOfMethod(method);
      if (key !== undefined) keys.push({ kid: absolute(document.id, method.id), key });
    } catch {
      // A key that does not read is no key.
    }
  }
  return keys;
}

const signing: Relationship[] = ["authentication", "assertionMethod", "capabilityInvocation", "capabilityDelegation"];

/**
 * The document of a did:key. An Ed25519 key also agrees on secrets by the
 * X25519 key derived from it, as the method's encryption key derivation
 * does; a key of a NIST curve agrees on secrets itself.
 */
export function resolveDidKey(did: string): DidDocument {
  const value = did.slice("did:key:".length);
  if (!did.startsWith("did:key:z") || value.includes(":")) throw new Error(`${did} is not a did:key`);
  const key = publicKeyFromMultibase(value);
  const method = (multibase: string) => ({
    id: `${did}#${multibase}`,
    type: "Multikey",
    controller: did,
    publicKeyMultibase: multibase,
  });
  const document: Record<string, unknown> & { id: string } = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [method(value)],
  };
  if (key.curve === "X25519") {
    document.keyAgreement = [`${did}#${value}`];
    return document;
  }
  for (const relationship of signing) document[relationship] = [`${did}#${value}`];
  if (key.curve === "Ed25519") {
    const agreement = method(multibaseOf(x25519KeyOf(key)));
    document.verificationMethod = [method(value), agreement];
    document.keyAgreement = [agreement.id];
  } else if (key.curve !== "secp256k1") {
    document.keyAgreement = [`${did}#${value}`];
  }
  return document;
}

// did:peer:2's abbreviations of a service: of key names, and of the value
// of `type`.
const abbreviations: [string, string][] = [
  ["type", "t"],
  ["serviceEndpoint", "s"],
  ["routingKeys", "r"],
  ["accept", "a"],
];
const expansions = new Map(abbreviations.map(([full, short]) => [short, full]));
const contractions = new Map(abbreviations);

function rename(value: unknown, names: Map<string, string>, types: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rename(item, names, types));
  if (!isObject(value)) return value;
  // fromEntries defines each name as the object's own, even __proto__.
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      const newName = names.get(name) ?? name;
      const isType = name === "type" || newName === "type";
      const newItem = isType && typeof item === "string" ? (types.get(item) ?? item) : item;
      return [newName, rename(newItem, names, types)];
    }),
  );
}

const purposes = new Map<string, Relationship>([
  ["A", "assertionMethod"],
  ["E", "keyAgreement"],
  ["V", "authentication"],
  ["I", "capabilityInvocation"],
  ["D", "capabilityDelegation"],
]);
const purposeCodes = new Map([...purposes].map(([code, relationship]) => [relationship, code]));

/**
 * The document of a did:peer:2. Keys are `#key-1`, `#key-2` and on, in the
 * order the DID gives them; a service without an id is `#service`, then
 * `#service-1` and on.
 */
export function resolvePeerDid2(did: string): DidDocument {
  const [head, ...elements] = did.slice("did:peer:2".length).split(".");
  if (!did.startsWith("did:peer:2") || head !== "" || elements.length === 0)
    throw new Error(`${did} is not a did:peer:2`);
  const document: Record<string, unknown> & { id: string } = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
  };
  const methods: JsonObject[] = [];
  const services: JsonObject[] = [];
  let unnamedServices = 0;
  for (const element of elements) {
    const code = element.slice(0, 1);
    const value = element.slice(1);
    if (code === "S") {
      const service = rename(
        parseObject(textOf(fromBase64url(value.replace(/=+$/, ""), "a service")), "a service"),
        expansions,
        new Map([["dm", "DIDCommMessaging"]]),
      );
      if (!isObject(service)) throw new Error("a service is not an object");
      if (service.id === undefined) {
        service.id = unnamedServices === 0 ? "#service" : `#service-${unnamedServices}`;
        unnamedServices += 1;
      }
      services.push(service);
      continue;
    }
    const relationship = purposes.get(code);
    if (relationship === undefined) throw new Error(`${did} has an element of unknown purpose ${code}`);
    publicKeyFromMultibase(value);
    const id = `#key-${methods.length + 1}`;
    methods.push({ id, type: "Multikey", controller: did, publicKeyMultibase: value });
    const relationships = document[relationship];
    document[relationship] = Array.isArray(relationships) ? [...relationships, id] : [id];
  }
  if (methods.length > 0) document.verificationMethod = methods;
  if (services.length > 0) document.service = services;
  return document;
}

export interface PeerDid2Input {
  readonly keys: readonly { readonly purpose: Relationship; readonly key: PublicKey }[];
  readonly services?: readonly JsonObject[];
}

/** Writes a did:peer:2 of keys and services, in the order given. */
export function peerDid2({ keys, services = [] }: PeerDid2Input): string {
  const elements = keys.map(({ purpose, key }) => `.${purposeCodes.get(purpose)}${multibaseOf(key)}`);
  for (const service of services) {
    const abbreviated = rename(service, contractions, new Map([["DIDCommMessaging", "dm"]]));
    elements.push(`.S${base64url(utf8(JSON.stringify(abbreviated)))}`);
  }
  return `did:peer:2${elements.join("")}`;
}

// The multihash of SHA-256, and the multicodec of JSON.
const sha256Multihash = [0x12, 0x20];
const jsonMulticodec = [0x80, 0x04];

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

function multibase(prefix: readonly number[], bytes: Uint8Array): string {
  const prefixed = new Uint8Array(prefix.length + bytes.length);
  prefixed.set(prefix);
  prefixed.set(bytes, prefix.length);
  return `z${base58.encode(prefixed)}`;
}

/** The short form of a did:peer:4, and the input document of its long form, if it has one. */
function splitPeerDid4(did: string): { short: string; document: JsonObject | undefined } {
  const match = /^did:peer:4(z[1-9A-HJ-NP-Za-km-z]+)(?::(z[1-9A-HJ-NP-Za-km-z]+))?$/.exec(did);
  if (match === null) throw new Error(`${did} is not a did:peer:4`);
  const [, hash = "", encoded] = match;
  const short = `did:peer:4${hash}`;
  if (encoded === undefined) return { short, document: undefined };
  if (hash !== multibase(sha256Multihash, sha256(utf8(encoded)))) throw new Error(`${did} is not of its document`);
  const bytes = base58.decode(encoded.slice(1));
  if (!hasPrefix(bytes, jsonMulticodec)) throw new Error(`${did} does not encode JSON`);
  const document = parseObject(textOf(bytes.subarray(jsonMulticodec.length)), "the document of a did:peer:4");
  if (document.id !== undefined) throw new Error("the input document of a did:peer:4 has an id");
  return { short, document };
}

/** The document of a did:peer:4, in the form `did` takes, `other` being the other form. */
function contextualize(input: JsonObject, did: string, other: string): DidDocument {
  const document = structuredClone(input) as Record<string, unknown>;
  const setController = (method: unknown) => {
    if (isObject(method) && method.controller === undefined) method.controller = did;
  };
  if (Array.isArray(document.verificationMethod)) document.verificationMethod.forEach(setController);
  for (const relationship of [...signing, "keyAgreement"]) {
    const entries = document[relationship];
    if (Array.isArray(entries)) entries.forEach(setController);
  }
  const aliases = Array.isArray(document.alsoKnownAs) ? document.alsoKnownAs : [];
  return { ...document, id: did, alsoKnownAs: [...aliases, other] };
}

/** Writes the long form of a did:peer:4 of an input document, which has no id and only relative references. */
export function peerDid4(input: JsonObject): string {
  if (input.id !== undefined) throw new Error("the input document of a did:peer:4 has no id");
  const encoded = multibase(jsonMulticodec, utf8(JSON.stringify(input)));
  return `did:peer:4${multibase(sha256Multihash, sha256(utf8(encoded)))}:${encoded}`;
}

/** The form of a DID that names it: the short form of a did:peer:4, which its long form also names. */
export function canonicalDid(did: string): string {
  return did.startsWith("did:peer:4") ? splitPeerDid4(did).short : did;
}

/** Whether two DIDs name the same subject: equal, or the two forms of one did:peer:4. */
export function sameDid(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("did:peer:4") || !b.startsWith("did:peer:4")) return false;
  try {
    return canonicalDid(a) === canonicalDid(b);
  } catch {
    return false;
  }
}

/**
 * Resolves did:key, did:peer:2 and did:peer:4 with no network, and other
 * methods by `fallback`, if given. A did:peer:4 resolves in its short form
 * once its long form has resolved here; the latest `remembered` long forms
 * are kept.
 */
export class OfflineResolver implements DidResolver {
  readonly #fallback: DidResolver | undefined;
  readonly #remembered: number;
  readonly #longForms = new Map<string, string>();

  constructor(options: { fallback?: DidResolver; remembered?: number } = {}) {
    this.#fallback = options.fallback;
    this.#remembered = options.remembered ?? 10_000;
  }

  async resolve(did: string): Promise<DidDocument | undefined> {
    if (did.startsWith("did:key:")) return resolveDidKey(did);
    if (did.startsWith("did:peer:2")) return resolvePeerDid2(did);
    if (did.startsWith("did:peer:4")) {
      const { short, document } = splitPeerDid4(did);
      if (document !== undefined) {
        this.#remember(short, did);
        return contextualize(document, did, short);
      }
      const long = this.#longForms.get(short);
      if (long === undefined) return undefined;
      const { document: input } = splitPeerDid4(long);
      return input === undefined ? undefined : contextualize(input, short, long);
    }
    return this.#fallback?.resolve(did);
  }

  #remember(short: string, long: string): void {
    this.#longForms.delete(short);
    this.#longForms.set(short, long);
    if (this.#longForms.size > this.#remembered) {
      const [oldest] = this.#longForms.keys();
      if (oldest !== undefined) this.#longForms.delete(oldest);
    }
  }
}
