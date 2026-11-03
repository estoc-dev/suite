import type { ECDSA } from "@noble/curves/abstract/weierstrass.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256, p384, p521 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { base64url, fromBase64url, isObject, optionalString, requiredString } from "./encoding.ts";

export type CurveName = "Ed25519" | "X25519" | "P-256" | "P-384" | "P-521" | "secp256k1";

/** The JWS algorithms DIDComm verifies. */
export type SignatureAlgorithm = "EdDSA" | "ES256" | "ES256K";

export interface PublicKey {
  readonly curve: CurveName;
  /** Raw for Ed25519 and X25519; for the others, the uncompressed SEC1 point. */
  readonly bytes: Uint8Array;
}

/** A public key, and the DID URL that names it in a DID document. */
export interface NamedKey {
  readonly kid: string;
  readonly key: PublicKey;
}

/** A public JWK, as an `epk` holds one. */
export interface Jwk {
  readonly kty: "OKP" | "EC";
  readonly crv: CurveName;
  readonly x: string;
  readonly y?: string;
}

interface Signature {
  readonly alg: SignatureAlgorithm;
  readonly sign: (message: Uint8Array, secret: Uint8Array) => Uint8Array;
  readonly verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
}

interface Curve {
  readonly kty: "OKP" | "EC";
  /** Bytes of a coordinate. */
  readonly size: number;
  /** The multicodec of a public key on the curve, as did:key and Multikey write it. */
  readonly multicodec: number;
  /** Checks bytes as a public key, and gives them in the one encoding a PublicKey holds. */
  readonly normalize: (bytes: Uint8Array) => Uint8Array;
  readonly compress: (bytes: Uint8Array) => Uint8Array;
  readonly publicKeyOf: (secret: Uint8Array) => Uint8Array;
  readonly randomSecret: () => Uint8Array;
  /** ECDH, giving Z as JWA has it: the x coordinate for the curves that have two. */
  readonly agree: ((secret: Uint8Array, publicKey: Uint8Array) => Uint8Array) | undefined;
  readonly signature: Signature | undefined;
}

function okp(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new Error("the key is not 32 bytes");
  return bytes.slice();
}

// Verification is strict: an Ed25519 key or signature has one encoding.
const ed25519Curve: Curve = {
  kty: "OKP",
  size: 32,
  multicodec: 0xed,
  normalize: (bytes) => {
    ed25519.Point.fromBytes(okp(bytes)).assertValidity();
    return bytes.slice();
  },
  compress: (bytes) => bytes,
  publicKeyOf: (secret) => ed25519.getPublicKey(secret),
  randomSecret: () => ed25519.utils.randomSecretKey(),
  agree: undefined,
  signature: {
    alg: "EdDSA",
    sign: (message, secret) => ed25519.sign(message, secret),
    verify: (signature, message, publicKey) => ed25519.verify(signature, message, publicKey, { zip215: false }),
  },
};

// Any 32 bytes are an X25519 key. A key of small order gives an all-zero
// secret, which x25519 refuses.
const x25519Curve: Curve = {
  kty: "OKP",
  size: 32,
  multicodec: 0xec,
  normalize: okp,
  compress: (bytes) => bytes,
  publicKeyOf: (secret) => x25519.getPublicKey(secret),
  randomSecret: () => x25519.utils.randomSecretKey(),
  agree: (secret, publicKey) => x25519.getSharedSecret(secret, publicKey),
  signature: undefined,
};

// A point is checked to be on the curve before it is used, as DIDComm asks
// for keys that come in a message: an invalid point would leak the secret.
// Signatures are verified whether or not `s` is low, since JOSE does not ask
// for it and Web Crypto does not write it.
function weierstrass(
  curve: ECDSA,
  size: number,
  multicodec: number,
  agreement: boolean,
  alg: SignatureAlgorithm | undefined,
): Curve {
  const point = (bytes: Uint8Array) => {
    const p = curve.Point.fromBytes(bytes);
    p.assertValidity();
    return p;
  };
  return {
    kty: "EC",
    size,
    multicodec,
    normalize: (bytes) => point(bytes).toBytes(false),
    compress: (bytes) => point(bytes).toBytes(true),
    publicKeyOf: (secret) => curve.getPublicKey(secret, false),
    randomSecret: () => curve.utils.randomSecretKey(),
    agree: agreement ? (secret, publicKey) => curve.getSharedSecret(secret, publicKey, true).subarray(1) : undefined,
    signature:
      alg === undefined
        ? undefined
        : {
            alg,
            sign: (message, secret) => curve.sign(message, secret),
            verify: (signature, message, publicKey) => curve.verify(signature, message, publicKey, { lowS: false }),
          },
  };
}

const curves = new Map<string, Curve>([
  ["Ed25519", ed25519Curve],
  ["X25519", x25519Curve],
  ["P-256", weierstrass(p256, 32, 0x1200, true, "ES256")],
  ["P-384", weierstrass(p384, 48, 0x1201, true, undefined)],
  ["P-521", weierstrass(p521, 66, 0x1202, true, undefined)],
  ["secp256k1", weierstrass(secp256k1, 32, 0xe7, false, "ES256K")],
]);

function curveOf(name: CurveName): Curve {
  const curve = curves.get(name);
  if (curve === undefined) throw new Error(`unknown curve ${name}`);
  return curve;
}

function isCurveName(name: unknown): name is CurveName {
  return typeof name === "string" && curves.has(name);
}

/** Checks a public key on a curve. */
export function publicKey(curve: CurveName, bytes: Uint8Array): PublicKey {
  try {
    return { curve, bytes: curveOf(curve).normalize(bytes) };
  } catch (cause) {
    throw new Error(`not a ${curve} public key`, { cause });
  }
}

/** Whether ECDH works with keys on the curve: X25519, P-256, P-384 and P-521. */
export function agrees(curve: CurveName): boolean {
  return curveOf(curve).agree !== undefined;
}

/** The algorithm that signs with keys on the curve, if any. */
export function signatureAlgorithmOf(curve: CurveName): SignatureAlgorithm | undefined {
  return curveOf(curve).signature?.alg;
}

export function sameKey(a: PublicKey, b: PublicKey): boolean {
  return a.curve === b.curve && a.bytes.length === b.bytes.length && a.bytes.every((byte, i) => byte === b.bytes[i]);
}

/** Verifies a JWS signature; false when `alg` is not the algorithm of the key's curve. */
export function verifySignature(alg: string, key: PublicKey, signature: Uint8Array, message: Uint8Array): boolean {
  const scheme = curveOf(key.curve).signature;
  if (scheme === undefined || scheme.alg !== alg) return false;
  try {
    return scheme.verify(signature, message, key.bytes);
  } catch {
    return false;
  }
}

/** The X25519 key of an Ed25519 key, as did:key derives one for key agreement. */
export function x25519KeyOf(key: PublicKey): PublicKey {
  if (key.curve !== "Ed25519") throw new Error("only an Ed25519 key has an X25519 key derived from it");
  return { curve: "X25519", bytes: ed25519.utils.toMontgomery(key.bytes) };
}

export function publicKeyFromJwk(jwk: unknown): PublicKey {
  if (!isObject(jwk)) throw new Error("the JWK is not an object");
  const crv = jwk.crv;
  if (!isCurveName(crv)) throw new Error(`the JWK's curve ${String(crv)} is not supported`);
  const curve = curveOf(crv);
  if (jwk.kty !== curve.kty) throw new Error(`the JWK's kty is not ${curve.kty} for ${crv}`);
  const x = fromBase64url(requiredString(jwk, "x", "the JWK"), "the JWK's x");
  if (curve.kty === "OKP") return publicKey(crv, x);
  const y = fromBase64url(requiredString(jwk, "y", "the JWK"), "the JWK's y");
  if (x.length !== curve.size || y.length !== curve.size)
    throw new Error(`the JWK's x or y is not ${curve.size} bytes`);
  const point = new Uint8Array(1 + 2 * curve.size);
  point[0] = 4;
  point.set(x, 1);
  point.set(y, 1 + curve.size);
  return publicKey(crv, point);
}

export function jwkOf(key: PublicKey): Jwk {
  const curve = curveOf(key.curve);
  if (curve.kty === "OKP") return { kty: "OKP", crv: key.curve, x: base64url(key.bytes) };
  return {
    kty: "EC",
    crv: key.curve,
    x: base64url(key.bytes.subarray(1, 1 + curve.size)),
    y: base64url(key.bytes.subarray(1 + curve.size)),
  };
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

/** Reads a key as Multikey and did:key write it: `z`, base58btc of the multicodec and the key. */
export function publicKeyFromMultibase(text: string): PublicKey {
  if (!text.startsWith("z")) throw new Error("the multibase key is not base58btc");
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(text.slice(1));
  } catch (cause) {
    throw new Error("the multibase key is not base58btc", { cause });
  }
  for (const [name, curve] of curves) {
    const prefix = varint(curve.multicodec);
    if (prefix.every((byte, i) => bytes[i] === byte))
      return publicKey(name as CurveName, bytes.subarray(prefix.length));
  }
  throw new Error("the multibase key is of no supported multicodec");
}

/** Writes a key as Multikey and did:key do; a point is compressed. */
export function multibaseOf(key: PublicKey): string {
  const curve = curveOf(key.curve);
  const compressed = curve.compress(key.bytes);
  const prefix = varint(curve.multicodec);
  const bytes = new Uint8Array(prefix.length + compressed.length);
  bytes.set(prefix);
  bytes.set(compressed, prefix.length);
  return `z${base58.encode(bytes)}`;
}

/**
 * A secret key, held privately as a signer holds one. It agrees on a
 * secret with another key, or signs, by what its curve does.
 */
export class SecretKey {
  readonly #secret: Uint8Array;
  readonly publicKey: PublicKey;

  private constructor(secret: Uint8Array, publicKey: PublicKey) {
    this.#secret = secret;
    this.publicKey = publicKey;
  }

  static fromBytes(curve: CurveName, secret: Uint8Array): SecretKey {
    const bytes = secret.slice();
    let publicBytes: Uint8Array;
    try {
      publicBytes = curveOf(curve).publicKeyOf(bytes);
    } catch (cause) {
      throw new Error(`not a ${curve} secret key`, { cause });
    }
    return new SecretKey(bytes, publicKey(curve, publicBytes));
  }

  static random(curve: CurveName): SecretKey {
    return SecretKey.fromBytes(curve, curveOf(curve).randomSecret());
  }

  /** Reads a private JWK, refusing one whose public part is not of its `d`. */
  static fromJwk(jwk: unknown): SecretKey {
    const declared = publicKeyFromJwk(jwk);
    if (!isObject(jwk)) throw new Error("the JWK is not an object");
    const d = optionalString(jwk, "d", "the JWK");
    if (d === undefined) throw new Error("the JWK holds no secret key");
    const key = SecretKey.fromBytes(declared.curve, fromBase64url(d, "the JWK's d"));
    if (!sameKey(key.publicKey, declared)) throw new Error("the JWK's public key is not that of its secret key");
    return key;
  }

  get curve(): CurveName {
    return this.publicKey.curve;
  }

  /** ECDH with a key on the same curve. */
  agree(other: PublicKey): Uint8Array {
    const { agree } = curveOf(this.curve);
    if (agree === undefined) throw new Error(`${this.curve} keys do not agree on secrets here`);
    if (other.curve !== this.curve) throw new Error(`a ${other.curve} key does not agree with a ${this.curve} key`);
    return agree(this.#secret, other.bytes);
  }

  get algorithm(): SignatureAlgorithm | undefined {
    return curveOf(this.curve).signature?.alg;
  }

  sign(message: Uint8Array): Uint8Array {
    const { signature } = curveOf(this.curve);
    if (signature === undefined) throw new Error(`${this.curve} keys do not sign here`);
    return signature.sign(message, this.#secret);
  }
}

/** The secret key of each DID URL that names one of the holder's keys. */
export type Secrets = (kid: string) => SecretKey | undefined;

/** One of the holder's keys, and the DID URL that names it. */
export interface OwnKey {
  readonly kid: string;
  readonly secret: SecretKey;
}
