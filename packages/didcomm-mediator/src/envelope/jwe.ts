import { aeskw, cbc, gcm } from "@noble/ciphers/aes.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { equalBytes, randomBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  base64url,
  fromBase64url,
  isObject,
  optionalString,
  readEncodedObject,
  requiredString,
  textOf,
  uint32,
  utf8,
} from "./encoding.ts";
import {
  agrees,
  jwkOf,
  type NamedKey,
  type OwnKey,
  type PublicKey,
  publicKeyFromJwk,
  SecretKey,
  type Secrets,
} from "./keys.ts";

export const encryptedType = "application/didcomm-encrypted+json";

export type ContentEncryption = "A256CBC-HS512" | "A256GCM" | "XC20P";
export type KeyWrap = "ECDH-ES+A256KW" | "ECDH-1PU+A256KW";

/** A JWE in the General JSON Serialization, with one ephemeral key for every recipient. */
export interface Jwe {
  readonly protected: string;
  readonly recipients: readonly { readonly header: { readonly kid: string }; readonly encrypted_key: string }[];
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

interface Content {
  readonly keyLength: number;
  readonly ivLength: number;
  readonly tagLength: number;
  readonly encrypt: (
    cek: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ) => { ciphertext: Uint8Array; tag: Uint8Array };
  readonly decrypt: (
    cek: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ) => Uint8Array;
}

// AES_CBC_HMAC_SHA2 of RFC 7518, section 5.2: the first half of the key
// MACs, the second encrypts, and the tag is the first half of the MAC.
function cbcTag(cek: Uint8Array, iv: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const aadBits = new Uint8Array(8);
  new DataView(aadBits.buffer).setBigUint64(0, BigInt(aad.length) * 8n);
  return hmac(sha512, cek.subarray(0, 32), concatBytes(aad, iv, ciphertext, aadBits)).subarray(0, 32);
}

const a256cbcHs512: Content = {
  keyLength: 64,
  ivLength: 16,
  tagLength: 32,
  encrypt: (cek, iv, aad, plaintext) => {
    const ciphertext = cbc(cek.subarray(32), iv).encrypt(plaintext);
    return { ciphertext, tag: cbcTag(cek, iv, aad, ciphertext) };
  },
  decrypt: (cek, iv, aad, ciphertext, tag) => {
    // The tag is checked before anything is decrypted, so that a padding
    // error says nothing.
    if (!equalBytes(cbcTag(cek, iv, aad, ciphertext), tag)) throw new Error("the tag does not match");
    return cbc(cek.subarray(32), iv).decrypt(ciphertext);
  },
};

function aead(
  cipher: (
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
  ) => {
    encrypt(data: Uint8Array): Uint8Array;
    decrypt(data: Uint8Array): Uint8Array;
  },
  ivLength: number,
): Content {
  return {
    keyLength: 32,
    ivLength,
    tagLength: 16,
    encrypt: (cek, iv, aad, plaintext) => {
      const sealed = cipher(cek, iv, aad).encrypt(plaintext);
      return { ciphertext: sealed.subarray(0, -16), tag: sealed.subarray(-16) };
    },
    decrypt: (cek, iv, aad, ciphertext, tag) => cipher(cek, iv, aad).decrypt(concatBytes(ciphertext, tag)),
  };
}

const contents = new Map<string, Content>([
  ["A256CBC-HS512", a256cbcHs512],
  ["A256GCM", aead(gcm, 12)],
  ["XC20P", aead(xchacha20poly1305, 24)],
]);

function contentOf(enc: ContentEncryption): Content {
  const content = contents.get(enc);
  if (content === undefined) throw new Error(`unknown content encryption ${enc}`);
  return content;
}

/** The `apv` DIDComm asks for: SHA-256 of the recipients' kids, sorted and joined by `.`. */
export function apvOf(kids: readonly string[]): string {
  return base64url(sha256(utf8([...kids].sort().join("."))));
}

const empty = new Uint8Array(0);

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(uint32(bytes.length), bytes);
}

// The Concat KDF of NIST SP 800-56A, as RFC 7518 section 4.6.2 uses it, for
// a key of 256 bits: one round of SHA-256. ECDH-1PU in key wrapping mode
// also binds the content's tag, so the wrapped key commits to the content.
function keyEncryptionKey(z: Uint8Array, alg: KeyWrap, apu: Uint8Array, apv: Uint8Array, tag?: Uint8Array) {
  const otherInfo = concatBytes(
    lengthPrefixed(utf8(alg)),
    lengthPrefixed(apu),
    lengthPrefixed(apv),
    uint32(256),
    tag === undefined ? empty : lengthPrefixed(tag),
  );
  return sha256(concatBytes(uint32(1), z, otherInfo));
}

function encrypt(
  plaintext: Uint8Array,
  recipients: readonly NamedKey[],
  enc: ContentEncryption,
  sender: OwnKey | undefined,
): Jwe {
  const first = recipients[0];
  if (first === undefined) throw new Error("a message is encrypted to at least one key");
  const curve = first.key.curve;
  if (!agrees(curve)) throw new Error(`${curve} keys do not agree on secrets`);
  if (recipients.some((recipient) => recipient.key.curve !== curve)) {
    throw new Error("the recipients' keys are not all on one curve");
  }
  if (sender !== undefined && sender.secret.curve !== curve) {
    throw new Error("the sender's key is not on the recipients' curve");
  }
  const alg: KeyWrap = sender === undefined ? "ECDH-ES+A256KW" : "ECDH-1PU+A256KW";
  const ephemeral = SecretKey.random(curve);
  const apv = apvOf(recipients.map((recipient) => recipient.kid));
  const header = {
    typ: encryptedType,
    alg,
    enc,
    ...(sender === undefined ? {} : { skid: sender.kid, apu: base64url(utf8(sender.kid)) }),
    apv,
    epk: jwkOf(ephemeral.publicKey),
  };
  const protectedHeader = base64url(utf8(JSON.stringify(header)));
  const content = contentOf(enc);
  const cek = randomBytes(content.keyLength);
  const iv = randomBytes(content.ivLength);
  const { ciphertext, tag } = content.encrypt(cek, iv, utf8(protectedHeader), plaintext);
  const apu = sender === undefined ? empty : utf8(sender.kid);
  const apvBytes = fromBase64url(apv, "apv");
  return {
    protected: protectedHeader,
    recipients: recipients.map(({ kid, key }) => {
      const z =
        sender === undefined ? ephemeral.agree(key) : concatBytes(ephemeral.agree(key), sender.secret.agree(key));
      const kek = keyEncryptionKey(z, alg, apu, apvBytes, sender === undefined ? undefined : tag);
      return { header: { kid }, encrypted_key: base64url(aeskw(kek).encrypt(cek)) };
    }),
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
    tag: base64url(tag),
  };
}

/** Encrypts to keys on one curve, without saying who encrypted. */
export function anoncrypt(
  plaintext: Uint8Array,
  recipients: readonly NamedKey[],
  enc: ContentEncryption = "A256CBC-HS512",
): Jwe {
  return encrypt(plaintext, recipients, enc, undefined);
}

/**
 * Encrypts to keys on one curve, proving to them alone that `sender`
 * encrypted. ECDH-1PU allows A256CBC-HS512 alone, which commits to its key.
 */
export function authcrypt(plaintext: Uint8Array, sender: OwnKey, recipients: readonly NamedKey[]): Jwe {
  return encrypt(plaintext, recipients, "A256CBC-HS512", sender);
}

export interface Decrypted {
  readonly plaintext: Uint8Array;
  readonly alg: KeyWrap;
  readonly enc: ContentEncryption;
  /** The kid of the key that decrypted. */
  readonly recipient: string;
  /** For ECDH-1PU, the kid of the sender's key: `skid`, or `apu` without it. */
  readonly sender: string | undefined;
}

function isKeyWrap(alg: string): alg is KeyWrap {
  return alg === "ECDH-ES+A256KW" || alg === "ECDH-1PU+A256KW";
}

function isContentEncryption(enc: string): enc is ContentEncryption {
  return contents.has(enc);
}

/**
 * Decrypts a JWE with whichever of `secrets` it was encrypted to. For
 * ECDH-1PU, `senderKey` gives the key that `skid` names among the sender's
 * key agreement keys; none refuses the JWE.
 */
export async function decrypt(
  jwe: unknown,
  secrets: Secrets,
  senderKey: (skid: string) => Promise<PublicKey | undefined>,
): Promise<Decrypted> {
  if (!isObject(jwe)) throw new Error("the JWE is not an object");
  const protectedHeader = requiredString(jwe, "protected", "the JWE");
  const header = readEncodedObject(protectedHeader, "the JWE's protected header");
  const alg = requiredString(header, "alg", "the JWE's protected header");
  const enc = requiredString(header, "enc", "the JWE's protected header");
  if (!isKeyWrap(alg)) throw new Error(`the JWE's alg ${alg} is not supported`);
  if (!isContentEncryption(enc)) throw new Error(`the JWE's enc ${enc} is not supported`);
  if (alg === "ECDH-1PU+A256KW" && enc !== "A256CBC-HS512") throw new Error("ECDH-1PU allows A256CBC-HS512 alone");
  // Nothing here understands an extension, or compression.
  if (header.crit !== undefined) throw new Error("the JWE has critical extensions");
  if (header.zip !== undefined) throw new Error("the JWE is compressed");

  const epk = publicKeyFromJwk(header.epk);
  if (!agrees(epk.curve)) throw new Error(`the JWE's epk is on ${epk.curve}, which does not agree on secrets`);
  const apuText = optionalString(header, "apu", "the JWE's protected header");
  const apu = apuText === undefined ? empty : fromBase64url(apuText, "the JWE's apu");
  const apvText = optionalString(header, "apv", "the JWE's protected header");
  const apv = apvText === undefined ? empty : fromBase64url(apvText, "the JWE's apv");

  let sender: string | undefined;
  let senderPublicKey: PublicKey | undefined;
  if (alg === "ECDH-1PU+A256KW") {
    const skid = optionalString(header, "skid", "the JWE's protected header");
    const apuKid = apuText === undefined ? undefined : textOf(apu);
    if (skid !== undefined && apuKid !== undefined && skid !== apuKid) throw new Error("the JWE's skid and apu differ");
    sender = skid ?? apuKid;
    if (sender === undefined) throw new Error("the JWE names no sender key");
    senderPublicKey = await senderKey(sender);
    if (senderPublicKey === undefined) throw new Error(`${sender} is not a key agreement key of its DID`);
    if (senderPublicKey.curve !== epk.curve) throw new Error("the sender's key is not on the epk's curve");
  }

  const content = contentOf(enc);
  const iv = fromBase64url(jwe.iv, "the JWE's iv");
  const ciphertext = fromBase64url(jwe.ciphertext, "the JWE's ciphertext");
  const tag = fromBase64url(jwe.tag, "the JWE's tag");
  if (iv.length !== content.ivLength) throw new Error(`the JWE's iv is not ${content.ivLength} bytes`);
  if (tag.length !== content.tagLength) throw new Error(`the JWE's tag is not ${content.tagLength} bytes`);
  const aadText = optionalString(jwe, "aad", "the JWE");
  const aad = utf8(aadText === undefined ? protectedHeader : `${protectedHeader}.${aadText}`);

  if (!Array.isArray(jwe.recipients)) throw new Error("the JWE has no recipients");
  let held = false;
  for (const recipient of jwe.recipients) {
    if (!isObject(recipient) || !isObject(recipient.header)) continue;
    const kid = recipient.header.kid;
    if (typeof kid !== "string") continue;
    const secret = secrets(kid);
    if (secret === undefined || secret.curve !== epk.curve) continue;
    held = true;
    try {
      const encryptedKey = fromBase64url(recipient.encrypted_key, "the encrypted key");
      const z =
        senderPublicKey === undefined
          ? secret.agree(epk)
          : concatBytes(secret.agree(epk), secret.agree(senderPublicKey));
      const kek = keyEncryptionKey(z, alg, apu, apv, senderPublicKey === undefined ? undefined : tag);
      const cek = aeskw(kek).decrypt(encryptedKey);
      if (cek.length !== content.keyLength) continue;
      const plaintext = content.decrypt(cek, iv, aad, ciphertext, tag);
      return { plaintext, alg, enc, recipient: kid, sender };
    } catch {
      // Another recipient entry may be ours as well.
    }
  }
  throw new Error(held ? "the JWE does not decrypt" : "the JWE is encrypted to no key held here");
}
